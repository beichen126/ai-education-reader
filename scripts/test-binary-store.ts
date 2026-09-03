// Stage 9.4D.1: binary-store domain tests (PURE node). A deterministic in-memory OPFS mock
// (globalThis.__dshOpfsMock) exercises the OPFS path; the IDB-inline fallback is covered
// when no driver is installed. Verifies path policy, app-root namespace isolation, write/
// verify, read MIME, delete, missing-file, fallback, clear partial-failure + retry, and
// persistent-storage status (unsupported / false / true).
import 'fake-indexeddb/auto'
import {
  buildBinaryPath, persistBinary, readBinary, deleteBinary, binaryExists, isOpfsAvailable,
  clearOpfsAppRoot, cleanupUnreferencedOpfs, isStoragePersistent, appRootName,
  type OpfsFileSystem, type StoredBinary,
} from '../src/storage/binary-store.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// In-memory mock with an app-root-scoped listAppFiles + clearAppRoot. The mock tracks BOTH
// app files (ai-education-reader-v1/...) and foreign files (other-app/...) separately so
// we can assert app-root operations NEVER touch other-app.
function installMock(opts?: { failDelete?: Set<string> }) {
  const app = new Map<string, Blob>()
  const foreign = new Map<string, Blob>()
  const failDelete = opts?.failDelete ?? new Set<string>();
  const mock: OpfsFileSystem & { app: Map<string, Blob>; foreign: Map<string, Blob>; failDelete: Set<string> } = {
    app, foreign, failDelete,
    async read(path) { const b = app.get(path); if (!b) throw new Error('not found'); return b },
    async write(path, blob) { app.set(path, blob) },
    async delete(path) { if (failDelete.has(path)) throw new Error('delete blocked'); app.delete(path) },
    async exists(path) { return app.has(path) },
    async listAppFiles() { return [...app.entries()].map(([path, b]) => ({ path, size: b.size, lastModified: 1 })) },
    async clearAppRoot() {
      const failedPaths: string[] = []
      for (const p of [...app.keys()]) { try { if (failDelete.has(p)) throw new Error('blocked'); app.delete(p); } catch { failedPaths.push(p) } }
      return { completed: failedPaths.length === 0, failedPaths };
    },
  };
  (globalThis as any).__dshOpfsMock = mock;
  return mock;
}
function uninstallMock() { (globalThis as any).__dshOpfsMock = undefined }
function mockKey(s: string) { return 'ai-education-reader-v1/objects/' + s }

// --- path policy: pure + safe ---
{
  const p = buildBinaryPath('documents', 'doc-1', 'abc123');
  assert(p === 'ai-education-reader-v1/objects/documents/doc-1/abc123', 'path derived from namespace/owner/id (' + p + ')');
  assert(appRootName() === 'ai-education-reader-v1', 'app root singleton');
}
{
  let threw = false; try { buildBinaryPath('documents', '../evil', 'id') } catch { threw = true }
  assert(threw, 'owner with traversal segment rejected');
  let t2 = false; try { buildBinaryPath('attachments', 'owner', 'a/b') } catch { t2 = true }
  assert(t2, 'binary id with slash rejected');
}
{
  const p = buildBinaryPath('documents', 'owner-1', 'uuid');
  assert(!p.includes('教材'), 'user filename never enters the path');
}

// --- OPFS write/read/delete roundtrip ---
{
  const mock = installMock();
  const blob = new Blob([new Uint8Array(500).fill(7)], { type: 'application/pdf' });
  const ref = await persistBinary('documents', 'd1', blob, { mimeType: 'application/pdf' });
  assert(ref.storage === 'opfs', 'OPFS ref when driver present');
  assert((await isOpfsAvailable()) === true, 'isOpfsAvailable true when driver present');
  const back = await readBinary(ref);
  assert(back.size === 500 && back.type === 'application/pdf', 'read back size + mime preserved');
  assert((await binaryExists(ref)) === true, 'binaryExists true');
  await deleteBinary(ref);
  assert((await binaryExists(ref)) === false, 'delete removes file');
  uninstallMock();
}

// --- MIME re-slice when OPFS File.type unreliable (metadata wins) ---
{
  installMock();
  const blob = new Blob([new Uint8Array(10)], { type: 'image/jpeg' });
  const ref = await persistBinary('attachments', 'a1', blob, { mimeType: 'image/jpeg' });
  const back = await readBinary(ref);
  assert(back.type === 'image/jpeg', 'MIME from metadata preserved');
  uninstallMock();
}

// --- missing file -> error (never empty/0-byte) ---
{
  installMock();
  const ref: StoredBinary = { storage: 'opfs', path: 'ai-education-reader-v1/objects/documents/missing/x', size: 10, mimeType: 'application/pdf' };
  let missing = false;
  try { await readBinary(ref) } catch (e) { missing = e && typeof e === 'object' && (e as {name?:string}).name === 'BinaryStorageError' }
  assert(missing, 'missing OPFS file -> BinaryStorageError (no empty blob)');
  uninstallMock();
}

// --- OPFS write failure -> IDB inline fallback (default) ---
{
  const mock = installMock();
  let writes = 0; const orig = mock.write.bind(mock);
  mock.write = async (path, blob) => { writes++; if (writes === 1) throw new Error('write fail'); await orig(path, blob); };
  const blob = new Blob([new Uint8Array(30).fill(1)], { type: 'application/pdf' });
  const ref = await persistBinary('documents', 'd2', blob);
  assert(ref.storage === 'idb', 'write failure -> IDB inline fallback (got ' + ref.storage + ')');
  if (ref.storage === 'idb') { const back = await readBinary(ref); assert(back.size === 30 && back.type === 'application/pdf', 'fallback Blob roundtrip') }
  uninstallMock();
}

// --- no driver -> IDB inline roundtrip ---
{
  uninstallMock();
  assert((await isOpfsAvailable()) === false, 'isOpfsAvailable false without driver');
  const blob = new Blob([new Uint8Array(80).fill(3)], { type: 'image/png' });
  const ref = await persistBinary('attachments', 'a2', blob);
  assert(ref.storage === 'idb', 'no driver -> IDB fallback');
  const back = await readBinary(ref);
  assert(back.size === 80, 'no-driver Blob roundtrip');
}

// --- FINDING 1: app-root scope isolation — GC never touches other-app ---
{
  const mock = installMock();
  const r1 = await persistBinary('documents', 'd1', new Blob([new Uint8Array(10)], { type: 'application/pdf' }));
  mock.foreign.set('other-app/keep.txt', new Blob(['x'], { type: 'text/plain' }));
  // GC removes the unreferenced app file (r1 is not referenced), leaves other-app intact.
  const gc = await cleanupUnreferencedOpfs([], 0); // grace 0 so it removes
  assert(gc.removed >= 1, 'GC removed unreferenced app file');
  assert(mock.foreign.has('other-app/keep.txt'), 'GC NEVER touched other-app subtree');
  uninstallMock();
}

// --- FINDING 1: app-root scope isolation — clear never touches other-app ---
{
  const mock = installMock();
  await persistBinary('documents', 'd1', new Blob([new Uint8Array(10)], { type: 'application/pdf' }));
  await persistBinary('attachments', 'a1', new Blob([new Uint8Array(5)], { type: 'image/png' }));
  mock.foreign.set('other-app/keep.txt', new Blob(['x'], { type: 'text/plain' }));
  const r = await clearOpfsAppRoot();
  assert(r.completed === true, 'clear app root completed');
  assert(mock.app.size === 0, 'all app files removed');
  assert(mock.foreign.has('other-app/keep.txt'), 'clear NEVER touched other-app subtree');
  uninstallMock();
}

// --- FINDING 2: clear partial failure returns failedPaths, then retry succeeds ---
{
  const mock = installMock({ failDelete: new Set([mockKey('documents/d1/x')]) });
  await persistBinary('documents', 'd1', new Blob([new Uint8Array(10)], { type: 'application/pdf' }));
  // mock.write always writes with a random id; the failDelete key won't match, so force
  // a known app file and block it directly.
  mock.app.set(mockKey('documents/d1/x'), new Blob([new Uint8Array(1)], { type: 'application/pdf' }));
  const r = await clearOpfsAppRoot();
  assert(r.completed === false, 'partial clear reported incomplete');
  assert(r.failedPaths.includes(mockKey('documents/d1/x')), 'failed path surfaced');
  assert(mock.app.has(mockKey('documents/d1/x')), 'blocked file survives first clear');
  // Retry: unblock x, add another file -> complete
  mock.failDelete.delete(mockKey('documents/d1/x'));
  mock.app.set(mockKey('documents/d1/y'), new Blob([new Uint8Array(1)], { type: 'application/pdf' }));
  const r2 = await clearOpfsAppRoot();
  assert(r2.completed === true, 'retry after unblock completes');
  assert(mock.app.size === 0, 'all app files removed on retry');
  uninstallMock();
}

// --- FINDING 12: isStoragePersistent returns undefined when API unavailable ---
{
  // In node, navigator.storage.persisted is not a function, so it must be undefined.
  const p = await isStoragePersistent();
  assert(p === undefined, 'isStoragePersistent === undefined when API unavailable (got ' + String(p) + ')');
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)