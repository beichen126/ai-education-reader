// Stage 9.4D.1: backup integrity tests. A "complete backup" must NEVER silently omit data:
// any referenced document/attachment binary that cannot be read fails the export with a
// BackupError. Also verifies the document-record iterator reads each source binary EXACTLY
// once (N documents -> N binary reads), and the backup output is self-importable.
import 'fake-indexeddb/auto'
import { newStableId } from '../src/engine/types.ts'
import { createDocument, readDocumentSourceBlob } from '../src/documents/document-service.ts'
import { saveFiles } from '../src/engine/attachment-service.ts'
import { idbClearAll, idbPut, idbGet, closeDb } from '../src/storage/idb.ts'
import { type OpfsFileSystem } from '../src/storage/binary-store.ts'
import { buildBackup, buildPortableBackupPlan } from '../src/export/backup-export.ts'
import { restoreBackup, parseAndValidate, BackupError } from '../src/export/backup-import.ts'
import { getConversation, saveConversation, updateConversationOrganization } from '../src/storage/storage.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const pdfBlob = (n: number) => new Blob([new Uint8Array(n).fill(9)], { type: 'application/pdf' })

let readCount = 0
function installMock() {
  const app = new Map<string, Blob>()
  const mock: OpfsFileSystem & { app: Map<string, Blob> } = {
    app,
    async read(path) { const b = app.get(path); readCount++; if (!b) throw new Error('not found'); return b },
    async write(path, blob) { app.set(path, blob) },
    async delete(path) { app.delete(path) },
    async exists(path) { return app.has(path) },
    async listAppFiles() { return [...app.entries()].map(([p, b]) => ({ path: p, size: b.size, lastModified: 1 })) },
    async clearAppRoot() { for (const k of [...app.keys()]) try { app.delete(k) } catch {} return { completed: true, failedPaths: [] } },
  };
  (globalThis as any).__dshOpfsMock = mock;
  return mock;
}
function uninstallMock() { (globalThis as any).__dshOpfsMock = undefined; readCount = 0 }

// Sidebar changes survive a queued content writer and an export/import round trip.
{
  await idbClearAll()
  const pinned = { id: newStableId(), title: 'Pinned', createdAt: 1, updatedAt: 1, messages: [] }
  const archived = { ...pinned, id: newStableId(), title: 'Archived' }
  await saveConversation(pinned)
  await saveConversation(archived)
  await updateConversationOrganization(pinned.id, 'pin')
  await updateConversationOrganization(archived.id, 'pin')
  await updateConversationOrganization(archived.id, 'archive')
  await saveConversation({ ...archived, title: 'Archived with updated content', updatedAt: 2 })
  const backup = parseAndValidate(await buildBackup())
  await restoreBackup(backup)
  const restoredPin = await getConversation(pinned.id)
  const restoredArchive = await getConversation(archived.id)
  assert(typeof restoredPin.pinnedAt === 'number', 'backup round trip preserves pinned chats')
  assert(typeof restoredArchive.archivedAt === 'number' && restoredArchive.pinnedAt === undefined, 'backup round trip preserves archive and cleared pin after a stale content write')
  assert(restoredArchive.title === 'Archived with updated content', 'archive metadata and content both survive')
}

// --- FINDING 4: N documents -> EXACTLY N binary reads (record iterator, no hydrate-all) ---
{
  installMock();
  await idbClearAll();
  for (let i = 0; i < 3; i++) { const id = newStableId(); await createDocument({ id, fileName: 'd' + i + '.pdf', mimeType: 'application/pdf', fileSize: 100 + i, pageCount: 5, sourceBlob: pdfBlob(100 + i) }) }
  const before = readCount;
  await buildBackup();
  const after = readCount;
  assert(after - before === 3, 'backup read each of 3 document binaries exactly once (readCount ' + (after - before) + ')');
  uninstallMock();
}

// --- FINDING 3: a document binary that cannot be read FAILS the export ---
{
  installMock();
  await idbClearAll();
  const mock = (globalThis as any).__dshOpfsMock;
  const id = newStableId();
  await createDocument({ id, fileName: 'x.pdf', mimeType: 'application/pdf', fileSize: 10, pageCount: 2, sourceBlob: pdfBlob(10) });
  // Break the binary: remove the OPFS file from the store so readBinary fails.
  const row = await idbGet('documents', id);
  mock.app.delete(row.source.path);
  let threw = false;
  try { await buildBackup() } catch (e) { threw = e instanceof BackupError }
  assert(threw, 'missing document binary -> BackupError (export fails, never omits)');
  uninstallMock();
}

// --- FINDING 3: a referenced attachment binary that cannot be read FAILS the export ---
{
  installMock();
  await idbClearAll();
  const mock = (globalThis as any).__dshOpfsMock;
  const att = await saveFiles([new File([new Uint8Array([1,2,3,4])], 'i.png', { type: 'image/png' })]);
  // Reference it in a conversation message so it is picked up by buildBackup.
  const cid = newStableId();
  await saveConversation({ id: cid, title: 't', createdAt: 1, updatedAt: 1, messages: [{ id: newStableId(), role: 'user', content: 'hi', images: [att[0].id], createdAt: 1, updatedAt: 1 }] } as any);
  const row = await idbGet('attachments', att[0].id);
  mock.app.delete(row.binary.path);
  let threw = false;
  try { await buildBackup() } catch (e) { threw = e instanceof BackupError }
  assert(threw, 'missing attachment binary -> BackupError (export fails, never omits)');
  uninstallMock();
}

// --- FINDING 0.2: message references a completely MISSING attachment id -> BackupError ---
{
  installMock();
  await idbClearAll();
  const cid = newStableId();
  await saveConversation({ id: cid, title: 't', createdAt: 1, updatedAt: 1, messages: [{ id: newStableId(), role: 'user', content: 'hi', images: ['missing-id-not-in-store'], createdAt: 1, updatedAt: 1 }] } as any);
  let threw = false;
  try { await buildBackup() } catch (e) { threw = e instanceof BackupError }
  assert(threw, 'message.images=[missing-id] with NO attachment row -> BackupError (never silently skipped)');
  uninstallMock();
}

// --- FINDING 0.2: attachment row exists but meta is missing -> BackupError ---
{
  installMock();
  await idbClearAll();
  const att = await saveFiles([new File([new Uint8Array([1,2,3,4])], 'i.png', { type: 'image/png' })]);
  const cid = newStableId();
  await saveConversation({ id: cid, title: 't', createdAt: 1, updatedAt: 1, messages: [{ id: newStableId(), role: 'user', content: 'hi', images: [att[0].id], createdAt: 1, updatedAt: 1 }] } as any);
  // Strip the meta from the stored attachment row.
  const row = await idbGet('attachments', att[0].id);
  await idbPut('attachments', { id: row.id, binary: row.binary, blob: row.blob, recordVersion: row.recordVersion ?? 2 });
  let threw = false;
  try { await buildBackup() } catch (e) { threw = e instanceof BackupError }
  assert(threw, 'attachment row with no meta -> BackupError (never silently skipped)');
  uninstallMock();
}

// --- backup output is self-importable (roundtrip on a clean DB) ---
{
  installMock();
  await idbClearAll();
  const did = newStableId();
  await createDocument({ id: did, fileName: 'rt.pdf', mimeType: 'application/pdf', fileSize: 300, pageCount: 30, sourceBlob: pdfBlob(300) });
  const backup = await buildBackup();
  // parseAndValidate must accept it (proves a valid, complete backup shape).
  const valid = parseAndValidate(backup);
  assert(valid === backup, 'backup output passes parseAndValidate (self-importable)');
  await idbClearAll();
  const m = (globalThis as any).__dshOpfsMock;
  for (const k of [...m.app.keys()]) await m.delete(k);
  await restoreBackup(backup);
  const got = await (await import('../src/documents/document-service.ts')).getDocument(did);
  assert(got && got.sourceBlob.size === 300, 'restored backup document readable');
  uninstallMock();
}

{
  await idbClearAll()
  await idbPut('conversationBranches', { id: 'old-orphan', conversationId: 'deleted-root', forkMessageId: 'm', title: 'Old', createdAt: 1, updatedAt: 1, messages: [] })
  await idbPut('settings', { key: 'draft-branch:old-orphan', value: { text: 'old', imageIds: ['missing'] } })
  await idbPut('settings', { key: 'activeBranch:deleted-root', value: 'old-orphan' })
  assert((await buildBackup()).branches?.length === 0, 'JSON omits legacy branches whose main chat was deleted')
  const portable = await buildPortableBackupPlan()
  assert(portable.manifest.backup.branches?.length === 0 && portable.manifest.backup.branchDrafts?.length === 0, 'ZIP omits legacy orphan branch data')
  await saveConversation({ id: 'root', title: 'Live', createdAt: 1, updatedAt: 1, messages: [] })
  await idbPut('conversationBranches', { id: 'invalid-live', conversationId: 'root', forkMessageId: 'missing-fork', title: 'Invalid', createdAt: 1, updatedAt: 1, messages: [] })
  let rejected = false
  try { await buildPortableBackupPlan() } catch (error) { rejected = error instanceof BackupError }
  assert(rejected, 'ZIP validates remaining live branch references before producing a file')
}

await closeDb();
console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
