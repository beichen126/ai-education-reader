// Legacy binary -> OPFS migration (Stage 9.4D.1). NON-blocking, best-effort, run after app
// boot. Migrates document sourceBlob then attachment blob, ONE record at a time via the
// store KEYS (never collects every blob into memory). re-checks the current row inside the
// atomic update so a concurrently-removed/migrated row is never overwritten. OPFS
// unavailable -> no-op; a transient write fail keeps the legacy row intact for retry.
import { idbGet, idbGetAllKeys, idbUpdate } from './idb'
import { persistBinary, readBinary, deleteBinary, isOpfsAvailable, type StoredBinary } from './binary-store'
import type { StoredAttachmentRow } from './storage'

export type MigrationResult = { migratedDocuments: number; migratedAttachments: number; failed: number }

function isLegacyDoc(row: any): boolean { return row && !row.source && row.sourceBlob instanceof Blob }
function isLegacyAtt(row: any): boolean { return row && !row.binary && row.blob instanceof Blob }
function isOpfsRef(b: StoredBinary): boolean { return b.storage === 'opfs' }

/** Migrate legacy document rows (sourceBlob) to OPFS refs, one key at a time. */
async function migrateLegacyDocuments(): Promise<{ migrated: number; failed: number }> {
  let migrated = 0; let failed = 0;
  const opfsOk = await isOpfsAvailable();
  if (!opfsOk) return { migrated, failed };
  let keys: string[] = []
  try { keys = await idbGetAllKeys('documents'); } catch { return { migrated, failed } }
  for (const id of keys) {
    let row: any;
    try { row = await idbGet('documents', id); } catch { failed += 1; continue; }
    if (!isLegacyDoc(row)) continue;
    try {
      const blob = row.sourceBlob;
      const ref = await persistBinary('documents', id, blob, { mimeType: row.mimeType || 'application/pdf' });
      if (!isOpfsRef(ref)) { continue; }
      try {
        await idbUpdate('documents', id, (cur: any) => {
          if (!cur || cur.source || !(cur.sourceBlob instanceof Blob)) throw new Error('row changed');
          const { sourceBlob, ...rest } = cur;
          return { ...rest, source: ref, recordVersion: 2 };
        });
        migrated += 1;
      } catch (e) {
        await deleteBinary(ref).catch(() => {});
        if (e instanceof Error && e.message === 'row changed') continue;
        failed += 1;
      }
    } catch {
      // Transient OPFS write fail: legacy row stays intact (diagnostics can record, retry later).
      failed += 1;
    }
  }
  return { migrated, failed };
}

/** Migrate legacy attachment rows (blob) to OPFS refs, one key at a time. */
async function migrateLegacyAttachments(): Promise<{ migrated: number; failed: number }> {
  let migrated = 0; let failed = 0;
  const opfsOk = await isOpfsAvailable();
  if (!opfsOk) return { migrated, failed };
  let keys: string[] = []
  try { keys = await idbGetAllKeys('attachments'); } catch { return { migrated, failed } }
  for (const id of keys) {
    let row: StoredAttachmentRow | undefined;
    try { row = await idbGet('attachments', id); } catch { failed += 1; continue; }
    if (!isLegacyAtt(row)) continue;
    try {
      const blob = row.blob as Blob;
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
 * Migrates documents first, then attachments, one record at a time by key. OPFS
 * unavailable -> no-op (legacy rows stay). A failure keeps the legacy row usable.
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
  try { const ks = await idbGetAllKeys('documents'); for (const k of ks) { const r = await idbGet('documents', k); if (isLegacyDoc(r)) documents++ } } catch {}
  try { const ks = await idbGetAllKeys('attachments'); for (const k of ks) { const r = await idbGet('attachments', k); if (isLegacyAtt(r)) attachments++ } } catch {}
  return { documents, attachments };
}
