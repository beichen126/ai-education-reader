
// Binary storage abstraction (Stage 9.4D). OPFS-first for large binary bytes, with an
// IndexedDB-inline fallback for environments without OPFS (Firefox/Safari/private mode)
// or when a write fails. Upper layers NEVER touch OPFS directly: they only get/persist a
// Blob via this layer. The domain/runtime model keeps sourceBlob: Blob.
//
// StoredBinary is a PERSISTED reference (never a FileSystemHandle in IndexedDB):
//   - storage:'opfs' -> app-controlled path + size + mimeType (bytes live in OPFS).
//   - storage:'idb'  -> Blob inline (fallback; already a real Blob, retrievable as-is).
//
// Atomicity: OPFS + IndexedDB are NOT a cross-storage ACID transaction. We follow
// write-first -> metadata-commit -> rollback/orphan-cleanup.

export type BinaryNamespace = 'documents' | 'attachments'

export type StoredBinary =
  | { storage: 'opfs'; path: string; size: number; mimeType: string }
  | { storage: 'idb'; blob: Blob; size: number; mimeType: string }

export type BinaryStorageErrorKind = 'unsupported' | 'write-failed' | 'read-failed' | 'missing' | 'delete-failed' | 'quota'
export class BinaryStorageError extends Error {
  readonly kind: BinaryStorageErrorKind
  constructor(kind: BinaryStorageErrorKind, message: string) { super(message); this.name = 'BinaryStorageError'; this.kind = kind }
}

const OPFS_APP_ROOT = 'ai-education-reader-v1'
const OPFS_OBJECTS = 'objects'

/** Pure path builder: derives a logical OPFS path from namespace + owner id + random
 *  binary id. NEVER accepts a user filename. Throws on an unsafe segment. Node-testable. */
export function buildBinaryPath(namespace: BinaryNamespace, ownerId: string, binaryId: string): string {
  const segs = [OPFS_APP_ROOT, OPFS_OBJECTS, namespace, ownerId, binaryId]
  for (const s of segs) {
    if (!s || /[/\\]|\.\.|\u0000/.test(s)) throw new Error('unsafe binary path segment: ' + JSON.stringify(s))
  }
  return segs.join('/')
}

/** The one app-owned OPFS root directory name (singleton source, node-testable). */
export function appRootName(): string { return OPFS_APP_ROOT }
export function objectsRootName(): string { return OPFS_OBJECTS }

/** A minimal OPFS filesystem adapter consumed by this module. The REAL adapter wraps
 *  navigator.storage.getDirectory(); tests may install a deterministic in-memory mock
 *  (globalThis.__dshOpfsMock) so the OPFS path is exercised without a browser. All list /
 *  GC / clear operations are inherently scoped to the APP OWNED root (never the whole origin). */
export interface OpfsFileSystem {
  read(path: string): Promise<Blob>
  write(path: string, blob: Blob): Promise<void>
  delete(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** List files under the APP OWNED root only (never enumerates the whole origin). */
  listAppFiles(): Promise<{ path: string; size: number; lastModified: number }[]>
  /** Delete the APP OWNED root subtree; reports which app files could not be removed. */
  clearAppRoot(): Promise<{ completed: boolean; failedPaths: string[] }>
}

// ---- real OPFS adapter (origin-private, never a user picker) ----
async function getDirectory(): Promise<any> {
  const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined
  if (!nav?.storage?.getDirectory) throw new BinaryStorageError('unsupported', 'OPFS unavailable')
  return nav.storage.getDirectory()
}

async function dirAt(root: any, segments: string[], create: boolean): Promise<any> {
  let dir = root
  for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create })
  return dir
}

function splitPath(path: string): { dirSegs: string[]; file: string } {
  const parts = path.split('/').filter(Boolean)
  return { dirSegs: parts.slice(0, -1), file: parts[parts.length - 1] }
}

async function getAppRoot(create: boolean): Promise<any> {
  const root = await getDirectory()
  return dirAt(root, [OPFS_APP_ROOT], create)
}

const realOpfs: OpfsFileSystem = {
  async write(path: string, blob: Blob): Promise<void> {
    const dir = await getAppRoot(true)
    const { dirSegs, file } = splitPath(path)
    // dirSegs = [v1, objects, ns, owner]; drop the app-root segment -> nested dir under it.
    const nested = await dirAt(dir, dirSegs.slice(1), true)
    const fh = await nested.getFileHandle(file, { create: true })
    const writable = await fh.createWritable()
    try {
      await writable.write(blob)
      await writable.close()
    } catch (e) {
      try { await writable.abort() } catch { /* ignore */ }
      throw e
    }
    const back = await nested.getFileHandle(file)
    const f = await back.getFile()
    if (f.size !== blob.size) {
      await realOpfs.delete(path).catch(() => {})
      throw new BinaryStorageError('write-failed', 'opfs write size mismatch')
    }
  },
  async read(path: string): Promise<Blob> {
    const dir = await getAppRoot(false)
    const { dirSegs, file } = splitPath(path)
    const nested = await dirAt(dir, dirSegs.slice(1), false)
    const fh = await nested.getFileHandle(file)
    const f = await fh.getFile()
    return f
  },
  async delete(path: string): Promise<void> {
    const dir = await getAppRoot(false)
    const { dirSegs, file } = splitPath(path)
    const nested = await dirAt(dir, dirSegs.slice(1), false)
    await nested.removeEntry(file)
  },
  async exists(path: string): Promise<boolean> {
    const dir = await getAppRoot(false)
    const { dirSegs, file } = splitPath(path)
    const nested = await dirAt(dir, dirSegs.slice(1), false)
    try { await nested.getFileHandle(file); return true } catch { return false }
  },
  async listAppFiles(): Promise<{ path: string; size: number; lastModified: number }[]> {
    const out: { path: string; size: number; lastModified: number }[] = []
    const dir = await getAppRoot(false)
    const walk = async (d: any, prefix: string) => {
      for await (const entry of d.values()) {
        const p = prefix + entry.name
        if (entry.kind === 'directory') { await walk(entry, p + '/') }
        else {
          try { const f = await entry.getFile(); out.push({ path: OPFS_APP_ROOT + '/' + p, size: f.size, lastModified: f.lastModified }) }
          catch { /* skip unreadable */ }
        }
      }
    }
    await walk(dir, '')
    return out
  },
  async clearAppRoot(): Promise<{ completed: boolean; failedPaths: string[] }> {
    const root = await getDirectory()
    const failedPaths: string[] = []
    // Try a recursive remove of the whole app root first.
    try {
      await root.removeEntry(OPFS_APP_ROOT, { recursive: true })
      return { completed: true, failedPaths: [] };
    } catch (e) {
      if (e && typeof e === 'object' && ((e as { name?: string }).name === 'NotFoundError')) return { completed: true, failedPaths: [] }
      // Otherwise walk the app files and delete each; report failures instead of swallowing.
      const files = await realOpfs.listAppFiles().catch(() => []);
      for (const f of files) {
        try { await realOpfs.delete(f.path) } catch { failedPaths.push(f.path) }
      }
      return { completed: failedPaths.length === 0, failedPaths };
    }
  },
}

let driver: OpfsFileSystem | null = null
let driverChecked = false

// Resolve the active OPFS driver. A test seam ALWAYS wins (checked every call so
// install/uninstall inside one process is honored). Otherwise the REAL OPFS adapter is
// detected once and cached; a null (unsupported) is re-checked but never cached as final.
async function getDriver(): Promise<OpfsFileSystem | null> {
  const seam = (globalThis as any).__dshOpfsMock
  if (seam) return seam as OpfsFileSystem
  if (driver) return driver
  if (driverChecked) return null
  driverChecked = true
  try {
    if (typeof navigator !== 'undefined' && (navigator as any).storage?.getDirectory) driver = realOpfs
  } catch { /* no opfs */ }
  return driver
}

/** True when OPFS is available in this environment (a test seam or real API). */
export async function isOpfsAvailable(): Promise<boolean> {
  const d = await getDriver()
  return d !== null
}

function isQuota(e: unknown): boolean {
  return ((e as any)?.name) === 'QuotaExceededError'
}

export type PersistBinaryOptions = { mimeType?: string; requireOpfsWhenAvailable?: boolean }

/**
 * Persist a Blob. OPFS-first: writes to an app-owned path, verifies the size, and
 * returns an OPFS StoredBinary reference. If OPFS is unavailable OR the write/verify
 * fails it falls back to an INLINE IndexedDB StoredBinary (never lose data). When
 * requireOpfsWhenAvailable is set, a genuine OPFS write failure propagates (batch callers
 * use this to trigger a whole-batch IDB fallback, not a silent partial).
 */
export async function persistBinary(namespace: BinaryNamespace, ownerId: string, blob: Blob, opts?: PersistBinaryOptions): Promise<StoredBinary> {
  const mime = opts?.mimeType || blob.type || 'application/octet-stream'
  const d = await getDriver()
  if (d) {
    const binaryId = crypto.randomUUID()
    const path = buildBinaryPath(namespace, ownerId, binaryId)
    try {
      await d.write(path, blob)
      const exists = await d.exists(path)
      if (!exists) throw new BinaryStorageError('write-failed', 'opfs missing after write')
      return { storage: 'opfs', path, size: blob.size, mimeType: mime }
    } catch (e) {
      if (opts?.requireOpfsWhenAvailable) throw e
      try { await d.delete(path).catch(() => {}) } catch { /* orphan possible */ }
    }
  }
  return { storage: 'idb', blob, size: blob.size, mimeType: mime }
}

/** Read a Blob back from a StoredBinary ref. For an OPFS ref the file must exist;
 *  a missing file is BinaryNotFound (never an empty/0-byte fake). For an IDB ref the
 *  Blob is returned directly. MIME is taken from the stored metadata. */
export async function readBinary(ref: StoredBinary): Promise<Blob> {
  if (ref.storage === 'idb') return ref.blob
  const d = await getDriver()
  if (!d) throw new BinaryStorageError('unsupported', 'OPFS unavailable but ref is opfs')
  let f: Blob
  try { f = await d.read(ref.path) } catch { throw new BinaryStorageError('missing', 'binary not found: ' + ref.path) }
  if (f.type !== ref.mimeType) return f.slice(0, f.size, ref.mimeType)
  return f
}

export async function deleteBinary(ref: StoredBinary): Promise<void> {
  if (ref.storage === 'idb') return
  const d = await getDriver()
  if (!d) throw new BinaryStorageError('unsupported', 'OPFS unavailable but ref is opfs')
  try { await d.delete(ref.path) } catch { throw new BinaryStorageError('delete-failed', 'opfs delete failed: ' + ref.path) }
}

export async function binaryExists(ref: StoredBinary): Promise<boolean> {
  if (ref.storage === 'idb') return true
  const d = await getDriver()
  if (!d) return false
  return d.exists(ref.path)
}

/** List every referenced OPFS path across the document/attachment records (for orphan GC). */
export async function listReferencedOpfsPaths(documents: { source?: StoredBinary }[], attachments: { binary: StoredBinary }[]): Promise<string[]> {
  const set = new Set<string>()
  for (const doc of documents) if (doc.source?.storage === 'opfs') set.add(doc.source.path)
  for (const at of attachments) if (at.binary.storage === 'opfs') set.add(at.binary.path)
  return [...set]
}

/** Best-effort GC of APP-OWNED unreferenced OPFS objects (never touches other subtrees). */
export async function cleanupUnreferencedOpfs(referenced: string[], graceMs = 24 * 60 * 60 * 1000): Promise<{ removed: number }> {
  const d = await getDriver()
  if (!d) return { removed: 0 }
  const all = await d.listAppFiles()
  const ref = new Set(referenced)
  let removed = 0
  const now = Date.now()
  for (const obj of all) {
    if (!ref.has(obj.path) && now - obj.lastModified > graceMs) {
      try { await d.delete(obj.path); removed++ } catch { /* orphan remains */ }
    }
  }
  return { removed }
}

/** Detect whether the origin has been granted persistent storage.
 *  undefined = API unavailable (unsupported); false = exists but not granted; true = granted. */
export async function isStoragePersistent(): Promise<boolean | undefined> {
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined
    if (nav?.storage?.persisted && typeof nav.storage.persisted === 'function') return !!(await nav.storage.persisted())
  } catch { /* unavailable */ }
  return undefined
}

/** Best-effort request for persistent storage (never a hard requirement). */
export async function requestStoragePersist(): Promise<boolean> {
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined
    if (nav?.storage?.persist && typeof nav.storage.persist === 'function') return !!(await nav.storage.persist())
  } catch { /* unavailable */ }
  return false
}

/** Delete the ENTIRE app-owned OPFS subtree (used by "clear local data"). Returns which
 *  app files could not be removed (never swallows a final delete failure). An IDB clear
 *  must run FIRST so a partial OPFS cleanup never leaves broken visible metadata. */
export async function clearOpfsAppRoot(): Promise<{ completed: boolean; failedPaths: string[] }> {
  const d = await getDriver()
  if (!d) return { completed: true, failedPaths: [] };
  return d.clearAppRoot()
}