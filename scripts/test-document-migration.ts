// Stage 9.4D: legacy binary -> OPFS migration test. Seeds legacy IDB rows (sourceBlob /
// blob inline), runs migrateLegacyBinaryStorage with an in-memory OPFS mock, and verifies
// the rows moved to OPFS refs and no legacy blob remains.
import 'fake-indexeddb/auto'
import { idbGet, idbPut, idbClearAll, closeDb } from '../src/storage/idb.ts'
import { migrateLegacyBinaryStorage, countLegacyBinaryRows } from '../src/storage/migration.ts'
import { getDocument } from '../src/documents/document-service.ts'
import { type OpfsFileSystem } from '../src/storage/binary-store.ts'
import { newStableId } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

function installMock() {
  const files = new Map<string, Blob>()
  const mock: OpfsFileSystem & { files: Map<string, Blob> } = {
    files,
    async read(path) { const b = files.get(path); if (!b) throw new Error('nf'); return b },
    async write(path, blob) { files.set(path, blob) },
    async delete(path) { files.delete(path) },
    async exists(path) { return files.has(path) },
    async listAppFiles() { return [...files.entries()].map(([p, b]) => ({ path: p, size: b.size, lastModified: 1 })) },
    async clearAppRoot() { for (const k of [...files.keys()]) try { files.delete(k) } catch {} return { completed: true, failedPaths: [] } },
  };
  (globalThis as any).__dshOpfsMock = mock;
  return mock;
}
function uninstallMock() { (globalThis as any).__dshOpfsMock = undefined }

const pdfBlob = (n: number) => new Blob([new Uint8Array(n).fill(4)], { type: 'application/pdf' })

// --- legacy document readable BEFORE migration (lazy hydration) ---
{
  installMock();
  await idbClearAll();
  const id = newStableId();
  await idbPut('documents', { id, kind: 'pdf', fileName: 'legacy.pdf', mimeType: 'application/pdf', fileSize: 500, pageCount: 10, chapters: [], chapterSource: 'none', lastReadPage: 0, createdAt: 1, updatedAt: 1, sourceBlob: pdfBlob(500) });
  const before = await getDocument(id);
  assert(before && before.sourceBlob.size === 500, 'legacy document readable before migration');
}

// --- legacy attachment readable before migration ---
{
  const aid = newStableId();
  await idbPut('attachments', { id: aid, meta: { id: aid, name: 'a.png', mimeType: 'image/png', size: 4, createdAt: 1, updatedAt: 1 }, blob: new Blob([new Uint8Array([1,2,3,4])], { type: 'image/png' }) });
  const row = await idbGet('attachments', aid);
  assert(row && row.blob instanceof Blob, 'legacy attachment blob inline readable');
}

// --- run migration ---
{
  const res = await migrateLegacyBinaryStorage();
  assert(res.migratedDocuments >= 1, 'migrated at least 1 document');
  assert(res.migratedAttachments >= 1, 'migrated at least 1 attachment');
  const docKeys = await idbList('documents');
  const anyDoc = await idbGet('documents', docKeys[0]);
  assert(anyDoc && anyDoc.source && anyDoc.source.storage === 'opfs' && anyDoc.sourceBlob === undefined, 'document row now has OPFS source ref, no sourceBlob');
  const anyAtt = await (async () => { let r: any; await (await import('../src/storage/idb.ts')).idbScan('attachments', (row) => { if (!r && row.binary) r = row }); return r })();
  assert(anyAtt && anyAtt.binary && anyAtt.binary.storage === 'opfs' && anyAtt.blob === undefined, 'attachment row now has OPFS binary ref, no blob');
  const legacyCount = await countLegacyBinaryRows();
  assert(legacyCount.documents === 0 && legacyCount.attachments === 0, 'no legacy rows remain');
}

// --- post-migration hydration still works from OPFS ---
{
  const docId = (await idbList('documents'))[0];
  const got = await getDocument(docId);
  assert(got && got.sourceBlob.size === 500, 'restored document hydration after migration');
}

uninstallMock();
await closeDb();
console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

async function idbList(store: string): Promise<string[]> {
  const { idbGetAllKeys } = await import('../src/storage/idb.ts');
  return idbGetAllKeys(store);
}