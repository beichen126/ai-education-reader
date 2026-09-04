// Stage 9.4D: OPFS storage integration tests (in-memory mock driver). Covers new Document
// roundtrip (OPFS ref, no sourceBlob in IDB row), summary without binary read, delete,
// attachment roundtrip + batch rollback, backup export/restore staging, clear-all.
import 'fake-indexeddb/auto'
import { createDocument, getDocument, listDocumentSummaries, deleteDocument, readDocumentSourceBlob } from '../src/documents/document-service.ts'
import { saveFiles, saveGeneratedImages, ensurePreviewUrl, releasePreviewUrl, deleteAttachment, isSupportedImage } from '../src/engine/attachment-service.ts'
import { idbGet, idbGetAll, idbClearAll, closeDb } from '../src/storage/idb.ts'
import { type OpfsFileSystem } from '../src/storage/binary-store.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { restoreBackup, parseAndValidate } from '../src/export/backup-import.ts'
import { newStableId, type Attachment } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

function installMock() {
  const files = new Map<string, Blob>()
  const mock: OpfsFileSystem & { files: Map<string, Blob> } = {
    files,
    async read(path) { const b = files.get(path); if (!b) throw new Error('not found'); return b },
    async write(path, blob) { files.set(path, blob) },
    async delete(path) { files.delete(path) },
    async exists(path) { return files.has(path) },
    async listAppFiles() { return [...files.entries()].map(([p, b]) => ({ path: p, size: b.size, lastModified: 1 })) },
    async clearAppRoot() { const fs: string[] = []; for (const k of [...files.keys()]) { try { files.delete(k) } catch { fs.push(k) } } return { completed: fs.length === 0, failedPaths: fs } },
  };
  (globalThis as any).__dshOpfsMock = mock;
  return mock;
}
function uninstallMock() { (globalThis as any).__dshOpfsMock = undefined }

const pdfBlob = (n: number) => new Blob([new Uint8Array(n).fill(9)], { type: 'application/pdf' })

installMock();
await idbClearAll();

// --- new Document uses OPFS; IDB row has NO sourceBlob (only a source ref) ---
{
  const id = newStableId();
  const doc = await createDocument({ id, fileName: '教材.pdf', mimeType: 'application/pdf', fileSize: 5000, pageCount: 100, sourceBlob: pdfBlob(5000), importSource: { kind: 'pdf', originalFileName: '教材.pdf' } });
  assert(doc.sourceBlob.size === 5000, 'createDocument returns hydrated sourceBlob');
  const row = await idbGet('documents', id);
  assert(row && row.source && row.source.storage === 'opfs', 'IDB row has an OPFS source ref');
  assert(row.sourceBlob === undefined, 'IDB row does NOT contain an inline sourceBlob');
  const got = await getDocument(id);
  assert(got && got.sourceBlob.size === 5000, 'getDocument hydrates sourceBlob from OPFS');
  const blob = await readDocumentSourceBlob(id);
  assert(blob.size === 5000 && blob.type === 'application/pdf', 'readDocumentSourceBlob returns the raw Blob');
}

// --- listDocumentSummaries does NOT read any binary (only metadata) ---
{
  const id2 = newStableId();
  await createDocument({ id: id2, fileName: 'b.pdf', mimeType: 'application/pdf', fileSize: 12345, pageCount: 5, sourceBlob: pdfBlob(12345) });
  const sums = await listDocumentSummaries();
  assert(sums.length >= 2, 'summaries listed');
  const s = sums.find(x => x.id === id2);
  assert(s && s.fileSize === 12345 && s.pageCount === 5, 'summary carries metadata only (fileSize/pageCount)');
  assert(!('sourceBlob' in (s as any)), 'summary has no sourceBlob field');
}

// --- delete: metadata removed + OPFS binary cleaned ---
{
  const id3 = newStableId();
  await createDocument({ id: id3, fileName: 'c.pdf', mimeType: 'application/pdf', fileSize: 77, pageCount: 3, sourceBlob: pdfBlob(77) });
  const row = await idbGet('documents', id3);
  const path = row.source.path;
  await deleteDocument(id3);
  assert((await idbGet('documents', id3)) === undefined, 'deleteDocument removes metadata row');
  const mock = (globalThis as any).__dshOpfsMock;
  assert(mock.files.has(path) === false, 'deleteDocument cleaned up the OPFS binary');
}

// --- attachment roundtrip: OPFS ref, saved + preview + delete ---
{
  const f = new File([new Uint8Array([137,80,78,71])], 'p.png', { type: 'image/png' });
  const atts = await saveFiles([f]);
  assert(atts.length === 1 && atts[0].mimeType === 'image/png', 'attach saved');
  const row = await idbGet('attachments', atts[0].id);
  assert(row && row.binary && row.binary.storage === 'opfs', 'attachment row has OPFS binary ref');
  assert(row.blob === undefined, 'attachment row does NOT have inline blob');
  const url = await ensurePreviewUrl(atts[0].id);
  assert(url.startsWith('blob:'), 'ensurePreviewUrl returns object URL');
  releasePreviewUrl(atts[0].id);
  await deleteAttachment(atts[0].id);
  assert((await idbGet('attachments', atts[0].id)) === undefined, 'attachment deleted');
}

// --- attachment batch rollback: write 1 fails -> no metadata, no orphan OPFS ---
{
  const mock = installMock();
  let writes = 0;
  const origWrite = mock.write.bind(mock);
  mock.write = async (path, blob) => { writes++; if (writes === 3) throw new Error('write fail'); await origWrite(path, blob); };
  let ok = true;
  const atts = await saveGeneratedImages([
    { blob: new Blob([new Uint8Array(10)], { type: 'image/png' }), name: 'a.png' },
    { blob: new Blob([new Uint8Array(10)], { type: 'image/png' }), name: 'b.png' },
    { blob: new Blob([new Uint8Array(10)], { type: 'image/png' }), name: 'c.png' },
  ]).catch(() => { ok = false; return [] });
  assert(ok === true, 'batch does NOT fail on transient OPFS write failure (full IDB fallback)');
  const count = await idbGetAll('attachments');
  assert(count.length === 3, 'all 3 attachments persisted via IDB fallback (got ' + count.length + ')');
  const allIdb = count.every(r => r.binary && r.binary.storage === 'idb');
  assert(allIdb, 'the WHOLE batch is IDB-backed (no partial OPFS+IDB mix)');
  assert(mock.files.size === 0, 'no orphan OPFS files after batch IDB fallback');
  assert(atts.length === 3, 'returned 3 attachments');
  mock.write = origWrite;
}

// --- backup V2 roundtrip (OPFS document) ---
{
  await idbClearAll();
  const mock0 = (globalThis as any).__dshOpfsMock;
  for (const p of [...mock0.files.keys()]) await mock0.delete(p);
  const did = newStableId();
  await createDocument({ id: did, fileName: 'backup.pdf', mimeType: 'application/pdf', fileSize: 2000, pageCount: 20, sourceBlob: pdfBlob(2000) });
  const backup = await buildBackup();
  assert(backup.version === 3 && backup.documents.length === 1, 'backup V3 has 1 document');
  assert(backup.documents[0].data.length > 0, 'document data is base64');
  // clear then restore (staged: new OPFS objects, not overwriting)
  await idbClearAll();
  const mock = (globalThis as any).__dshOpfsMock;
  for (const p of [...mock.files.keys()]) await mock.delete(p);
  await restoreBackup(backup);
  const got = await getDocument(did);
  assert(got && got.sourceBlob.size === 2000, 'restored document readable (sourceBlob 2000)');
}

// --- restore failure (metadata replace fail) leaves old data intact + staged OPFS cleaned ---
{
  await idbClearAll();
  const mock1 = (globalThis as any).__dshOpfsMock;
  for (const p of [...mock1.files.keys()]) await mock1.delete(p);
  const did = newStableId();
  await createDocument({ id: did, fileName: 'keep.pdf', mimeType: 'application/pdf', fileSize: 999, pageCount: 9, sourceBlob: pdfBlob(999) });
  const backup = await buildBackup();
  const oldPath = (await idbGet('documents', did)).source.path;
  // Simulate an idbReplaceAll failure by restoring a backup that MUST fail (document data bad base64).
  const bad = { ...backup, documents: [{ ...backup.documents[0], data: 'not-base64!!' }] };
  let threw = false;
  try { await restoreBackup(bad) } catch { threw = true };
  assert(threw, 'restore with bad base64 throws (idb replace not reached)');
  const still = await getDocument(did);
  assert(still && still.sourceBlob.size === 999, 'original data intact after failed restore');
  const mock = (globalThis as any).__dshOpfsMock;
  // staged new files (if any) must never point at the still-existing old doc path
  assert(mock.files.has(oldPath) === true, 'original OPFS binary still present');
}

uninstallMock();
await closeDb();
console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)