// Stage 9.4D: binary-store domain tests (PURE node). A deterministic in-memory OPFS mock
// (globalThis.__dshOpfsMock) exercises the OPFS path; the IDB-inline fallback is covered
// when no driver is installed. Verifies path policy, write/verify, read MIME, delete,
// missing-file, fallback, and unsafe-path rejection.
import 'fake-indexeddb/auto'
import {
  buildBinaryPath, persistBinary, readBinary, deleteBinary, binaryExists, isOpfsAvailable,
  type OpfsFileSystem, type StoredBinary,
} from '../src/storage/binary-store.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

function installMock(failNext = 0) {
  const files = new Map<string, Blob>()
  let failCount = failNext;
  const mock: OpfsFileSystem & { files: Map<string, Blob> } = {
    files,
    async read(path) { const b = files.get(path); if (!b) throw new Error('not found'); return b },
    async write(path, blob) { if (failCount > 0) { failCount--; throw new Error('write failed') } files.set(path, blob) },
    async delete(path) { files.delete(path) },
    async exists(path) { return files.has(path) },
    async listAll() { return [...files.entries()].map(([path, b]) => ({ path, size: b.size, lastModified: 1 })) },
  };
  (globalThis as any).__dshOpfsMock = mock;
  return mock;
}
function uninstallMock() { (globalThis as any).__dshOpfsMock = undefined }

// --- path policy: pure + safe ---
{
  const p = buildBinaryPath('documents', 'doc-1', 'abc123');
  assert(p === 'ai-education-reader-v1/objects/documents/doc-1/abc123', 'path derived from namespace/owner/id (' + p + ')');
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

// --- OPFS write/read roundtrip ---
{
  installMock(0);
  const blob = new Blob([new Uint8Array(500).fill(7)], { type: 'application/pdf' });
  const ref = await persistBinary('documents', 'd1', blob, { mimeType: 'application/pdf' });
  assert(ref.storage === 'opfs', 'OPFS ref when driver present (got ' + ref.storage + ')');
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
  installMock(0);
  const blob = new Blob([new Uint8Array(10)], { type: 'image/jpeg' });
  const ref = await persistBinary('attachments', 'a1', blob, { mimeType: 'image/jpeg' });
  const back = await readBinary(ref);
  assert(back.type === 'image/jpeg', 'MIME from metadata preserved');
  uninstallMock();
}

// --- missing file -> error (never empty/0-byte) ---
{
  installMock(0);
  const ref: StoredBinary = { storage: 'opfs', path: 'ai-education-reader-v1/objects/documents/missing/x', size: 10, mimeType: 'application/pdf' };
  let missing = false;
  try { await readBinary(ref) } catch (e) { missing = e && typeof e === 'object' && (e as {name?:string}).name === 'BinaryStorageError' }
  assert(missing, 'missing OPFS file -> BinaryStorageError (no empty blob)');
  uninstallMock();
}

// --- OPFS write failure -> IDB inline fallback ---
{
  installMock(1); // fail the FIRST write
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

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)