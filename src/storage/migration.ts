// Legacy binary -> OPFS migration (Stage 9.4D). NON-blocking, best-effort, run after app
// boot. Migrates document sourceBlob then attachment blob, ONE record at a time (never
// getAll() every big Blob into memory). Uses keys + a cursor for the documents store.
import { idbScan, idbUpdate, idbGet, idbGetAllKeys, closeDb } from './idb'
import { persistBinary, readBinary, deleteBinary, isOpfsAvailable, type StoredBinary } from './binary-store'
import type { StoredAttachmentRow } from './storage'

export type MigrationResult = { migratedDocuments: number; migratedAttachments: number; failed: number }

function isLegacyDoc(row: any): boolean { return row && !row.source && row.sourceBlob instanceof Blob }
function isLegacyAtt(row: any): boolean { return row && !row.binary && row.blob instanceof Blob }

function isOpfsRef(b: StoredBinary): boolean { return b.storage === 'opfs' }

/** Migrate ALL legacy document rows (sourceBlob) to OPFS refs, one at a time. */
async function migrateLegacyDocuments(): Promise<{ migrated: number; failed: number }> {
  let migrated = 0; let failed = 0;
  const rows: any[] = [];
  await idbScan('documents', (row) => { if (isLegacyDoc(row)) rows.push(row) });
  for (const row of rows) {
    try {
      const id = row.id;
      const blob = row.sourceBlob;
      // persistBinary also falls back to IDB if OPFS is unavailable — but we only
      // want to migrate when OPFS is truly available (else keep legacy inline).
      const opfsOk = await isOpfsAvailable();
      if (!opfsOk) { failed += 1; continue; }
      const ref = await persistBinary('documents', id, blob, { mimeType: row.mimeType || 'application/pdf' });
      if (!isOpfsRef(ref)) { continue; }
      // Re-check the CURRENT row inside the atomic update (may have been migrated/deleted).
      try {
        await idbUpdate('documents', id, (cur: any) => {
          if (!cur || cur.source || !(cur.sourceBlob instanceof Blob)) throw new Error('row changed');
          const { sourceBlob, ...rest } = cur;
          return { ...rest, source: ref, recordVersion: 2 };
        });
        migrated += 1;
      } catch (e) {
        // Row was deleted/migrated concurrently -> delete the duplicate new object.
        await deleteBinary(ref).catch(() => {});
        if (e instanceof Error && e.message === 'row changed') continue;
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { migrated, failed };
}

/** Migrate ALL legacy attachment rows (blob) to OPFS refs, one at a time. */
async function migrateLegacyAttachments(): Promise<{ migrated: number; failed: number }> {
  let migrated = 0; let failed = 0;
  const rows: StoredAttachmentRow[] = [];
  await idbScan('attachments', (row) => { if (isLegacyAtt(row)) rows.push(row as StoredAttachmentRow) });
  for (const row of rows) {
    try {
      const id = row.id;
      const blob = row.blob as Blob;
      const opfsOk = await isOpfsAvailable();
      if (!opfsOk) { failed += 1; continue; }
      const ref = await persistBinary('attachments', id, blob, { mimeType: row.meta?.mimeType });
      if (!isOpfsRef(ref)) { continue; }
      try {
        await idbUpdate('attachments', id, (cur: any) => {
          if (!cur || cur.binary || !(cur.blob instanceof Blob)) throw new Error('row changed');
          const { blob: _b, ...rest } = cur;
          return { ...rest, binary: ref, recordVersion: 2 };
        });
        migrated += 1;
      } catch (e) {
        await deleteBinary(ref).catch(() => {});
        if (e instanceof Error && e.message === 'row changed') continue;
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { migrated, failed };
}

/**
 * Best-effort background migration. Does NOT block app render / library / conversation.
 * Migrates documents first, then attachments. OPFS unavailable -> no-op (legacy rows stay).
 * A failure on one record keeps the legacy row usable (never destructive).
 */
export async function migrateLegacyBinaryStorage(): Promise<MigrationResult> {
  const opfsOk = await isOpfsAvailable();
  if (!opfsOk) return { migratedDocuments: 0, migratedAttachments: 0, failed: 0 };
  const d = await migrateLegacyDocuments();
  const a = await migrateLegacyAttachments();
  return { migratedDocuments: d.migrated, migratedAttachments: a.migrated, failed: d.failed + a.failed };
}

/** Count legacy rows still waiting for migration (diagnostics display, non-blocking). */
export async function countLegacyBinaryRows(): Promise<{ documents: number; attachments: number }> {
  let documents = 0; let attachments = 0;
  try { await idbScan('documents', (r) => { if (isLegacyDoc(r)) documents++ }) } catch {}
  try { await idbScan('attachments', (r) => { if (isLegacyAtt(r)) attachments++ }) } catch {}
  return { documents, attachments };
}
