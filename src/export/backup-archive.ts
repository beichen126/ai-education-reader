import { strFromU8, strToU8, unzipSync, zipSync, Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { BackupError, parseAndValidate } from './backup-import'
import { PORTABLE_ARCHIVE_FORMAT, type Backup, type BackupAttachment, type BackupDocument, type PortableBackupManifest } from './backup-types'
import type { PortableBackupPlan } from './backup-export'
import { createBinaryWriteSink, deleteBinary, type BinaryWriteSink, type StoredBinary } from '../storage/binary-store'

export const BACKUP_ARCHIVE_ENTRY = 'ai-education-reader-backup.json'
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
const MAX_ENTRY_COUNT = 100_000

function hasZipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (
    (bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08)
  )
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

/** Read central-directory declarations before inflation, preventing tiny zip-bomb inputs
 * from allocating an unbounded output buffer. ZIP64 is intentionally rejected. */
function validateZipEnvelope(bytes: Uint8Array): void {
  if (!hasZipMagic(bytes)) throw new BackupError('不是有效的 ZIP 备份文件')
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new BackupError('ZIP 备份文件过大')
  let entries = 0
  let declaredTotal = 0
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (u32(bytes, i) !== 0x02014b50) continue
    const size = u32(bytes, i + 24)
    if (size === 0xffffffff) throw new BackupError('暂不支持 ZIP64 备份')
    declaredTotal += size
    entries++
    if (entries > MAX_ENTRY_COUNT || declaredTotal > MAX_UNCOMPRESSED_BYTES) throw new BackupError('ZIP 备份内容过大或文件数异常')
    const nameLength = u16(bytes, i + 28)
    const extraLength = u16(bytes, i + 30)
    const commentLength = u16(bytes, i + 32)
    i += 45 + nameLength + extraLength + commentLength
  }
  if (entries === 0) throw new BackupError('ZIP 备份缺少中央目录')
}

export function buildBackupArchive(backup: Backup): Blob {
  // API credentials are never part of the portable archive. Keep this explicit even if a
  // foreign object was cast to Backup by a caller.
  const safeSettings = { ...(backup.settings as Record<string, unknown>) }
  delete safeSettings.apiKey
  const safeBackup = { ...backup, settings: safeSettings }
  const json = JSON.stringify(safeBackup)
  const bytes = zipSync({ [BACKUP_ARCHIVE_ENTRY]: [strToU8(json), { level: 6 }] })
  return new Blob([bytes as unknown as BlobPart], { type: 'application/zip' })
}

async function pushBlob(file: ZipPassThrough, blob: Blob, drain: () => Promise<void>): Promise<void> {
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength) { file.push(value); await drain() }
    }
    file.push(new Uint8Array(0), true)
    return
  }
  const chunkSize = 1024 * 1024
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    file.push(new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()))
    await drain()
  }
  file.push(new Uint8Array(0), true)
}

/** ZIP v2 keeps large PDF/image bytes outside JSON and consumes one Blob stream at a time.
 * Peak memory is therefore the compressed archive plus a small stream chunk, rather than
 * base64 JSON + UTF-16 JSON + zipSync input + zipSync output. */
export async function writePortableBackupArchive(plan: PortableBackupPlan, write: (chunk: Uint8Array) => Promise<void>): Promise<void> {
  const safeSettings = { ...(plan.manifest.backup.settings as Record<string, unknown>) }
  delete safeSettings.apiKey
  const manifest: PortableBackupManifest = {
    ...plan.manifest,
    backup: { ...plan.manifest.backup, settings: safeSettings as PortableBackupManifest['backup']['settings'] },
  }
  let writes = Promise.resolve()
  let resolveDone!: () => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const zip = new Zip((error, chunk, final) => {
    if (error) { rejectDone(error); return }
    if (chunk.byteLength) {
      const owned = chunk.slice()
      writes = writes.then(() => write(owned))
    }
    if (final) writes.then(resolveDone, rejectDone)
  })
  const drain = () => writes
  try {
    const meta = new ZipDeflate(BACKUP_ARCHIVE_ENTRY, { level: 6 })
    zip.add(meta)
    meta.push(strToU8(JSON.stringify(manifest)), true)
    await drain()
    for (const binary of plan.binaries) {
      const file = new ZipPassThrough(binary.entry)
      zip.add(file)
      await pushBlob(file, binary.blob, drain)
    }
    zip.end()
  } catch (error) {
    zip.terminate()
    rejectDone(error)
  }
  await done
}

/** In-memory fallback for browsers without the File System Access API. */
export async function buildPortableBackupArchive(plan: PortableBackupPlan): Promise<Blob> {
  const parts: BlobPart[] = []
  await writePortableBackupArchive(plan, async chunk => { parts.push(chunk.buffer as ArrayBuffer) })
  return new Blob(parts, { type: 'application/zip' })
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) output += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  return btoa(output)
}

function isSafeEntry(entry: unknown, prefix: string): entry is string {
  return typeof entry === 'string' && entry.startsWith(prefix) && !entry.includes('..') && !entry.includes('\\') && entry.length <= 512
}

function hydratePortableManifest(manifest: PortableBackupManifest, files: Record<string, Uint8Array>): Backup {
  if (manifest.archiveFormat !== PORTABLE_ARCHIVE_FORMAT || manifest.archiveVersion !== 2 || !manifest.backup || typeof manifest.backup !== 'object') throw new BackupError('ZIP 备份清单格式不正确')
  if (!Array.isArray(manifest.backup.attachments) || !Array.isArray(manifest.backup.documents)) throw new BackupError('ZIP 备份清单格式不正确')
  const expected = new Set([BACKUP_ARCHIVE_ENTRY])
  const attachments: BackupAttachment[] = manifest.backup.attachments.map(item => {
    if (!isSafeEntry(item.entry, 'attachments/') || expected.has(item.entry)) throw new BackupError('ZIP 附件路径不正确')
    expected.add(item.entry)
    const bytes = files[item.entry]
    if (!bytes) throw new BackupError('ZIP 备份缺少附件：' + item.id.slice(0, 8))
    return { id: item.id, meta: item.meta, mimeType: item.mimeType, data: bytesToBase64(bytes) }
  })
  const documents: BackupDocument[] = manifest.backup.documents.map(item => {
    if (!isSafeEntry(item.entry, 'documents/') || expected.has(item.entry)) throw new BackupError('ZIP 文档路径不正确')
    expected.add(item.entry)
    const bytes = files[item.entry]
    if (!bytes) throw new BackupError('ZIP 备份缺少文档：' + item.id.slice(0, 8))
    return { id: item.id, meta: item.meta, mimeType: item.mimeType, data: bytesToBase64(bytes) }
  })
  if (Object.keys(files).some(name => !expected.has(name)) || expected.size !== Object.keys(files).length) throw new BackupError('ZIP 备份包含未声明的文件')
  return { ...manifest.backup, attachments, documents } as Backup
}

export function parseBackupArchive(bytes: Uint8Array): Backup {
  validateZipEnvelope(bytes)
  let files: Record<string, Uint8Array>
  try { files = unzipSync(bytes) } catch { throw new BackupError('ZIP 备份已损坏或无法解压') }
  const names = Object.keys(files)
  if (!names.includes(BACKUP_ARCHIVE_ENTRY)) throw new BackupError('ZIP 备份结构不正确')
  const data = files[BACKUP_ARCHIVE_ENTRY]
  if (!data || data.byteLength > MAX_UNCOMPRESSED_BYTES) throw new BackupError('ZIP 备份内容缺失或过大')
  let json: unknown
  try { json = JSON.parse(strFromU8(data)) } catch { throw new BackupError('ZIP 内的备份 JSON 无法解析') }
  if (json && typeof json === 'object' && (json as Record<string, unknown>).archiveFormat === PORTABLE_ARCHIVE_FORMAT) {
    return parseAndValidate(hydratePortableManifest(json as PortableBackupManifest, files))
  }
  if (names.length !== 1) throw new BackupError('ZIP 备份结构不正确')
  return parseAndValidate(json)
}

export type BackupBinarySource = {
  attachments: Map<string, Uint8Array | StoredBinary>
  documents: Map<string, Uint8Array | StoredBinary>
}

const MAX_STREAM_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_STREAM_MANIFEST_BYTES = 256 * 1024 * 1024
const ZIP_EOCD_MAX_BYTES = 65_535 + 22
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024

type PortableEntrySpec = {
  kind: 'attachments' | 'documents'
  id: string
  mimeType: string
  expectedSize?: number
}

/** Validate the end-of-central-directory without materializing the archive. Streaming unzip
 * alone can successfully emit local-file entries from a truncated ZIP whose central
 * directory is missing, so the tail must be checked independently before any staging. */
async function validateStreamingZipEnvelope(file: Blob): Promise<Map<string, number>> {
  if (file.size < 22) throw new BackupError('ZIP 备份已损坏或不完整')
  const tailOffset = Math.max(0, file.size - ZIP_EOCD_MAX_BYTES)
  const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer())
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) !== 0x06054b50) continue
    if (i + 22 + u16(tail, i + 20) === tail.length) { eocd = i; break }
  }
  if (eocd < 0) throw new BackupError('ZIP 备份缺少完整的中央目录，文件可能被截断')
  const disk = u16(tail, eocd + 4)
  const centralDisk = u16(tail, eocd + 6)
  const diskEntries = u16(tail, eocd + 8)
  const entries = u16(tail, eocd + 10)
  const centralSize = u32(tail, eocd + 12)
  const centralOffset = u32(tail, eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries) throw new BackupError('不支持分卷 ZIP 备份')
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new BackupError('暂不支持 ZIP64 备份')
  if (entries === 0 || entries > MAX_ENTRY_COUNT) throw new BackupError('ZIP 备份文件数异常')
  if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) throw new BackupError('ZIP 备份中央目录异常大')
  const eocdOffset = tailOffset + eocd
  if (centralOffset + centralSize !== eocdOffset || centralOffset + 4 > file.size) throw new BackupError('ZIP 备份中央目录不完整')
  const central = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer())
  const declared = new Map<string, number>()
  let cursor = 0
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > central.length || u32(central, cursor) !== 0x02014b50) throw new BackupError('ZIP 备份中央目录已损坏')
    const compression = u16(central, cursor + 10)
    const originalSize = u32(central, cursor + 24)
    const nameLength = u16(central, cursor + 28)
    const extraLength = u16(central, cursor + 30)
    const commentLength = u16(central, cursor + 32)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if ((compression !== 0 && compression !== 8) || originalSize === 0xffffffff || next > central.length) throw new BackupError('ZIP 备份使用了不支持的条目格式')
    const name = strFromU8(central.subarray(cursor + 46, cursor + 46 + nameLength))
    if (!name || name.length > 512 || declared.has(name)) throw new BackupError('ZIP 备份中央目录包含非法或重复路径')
    declared.set(name, originalSize)
    cursor = next
  }
  if (cursor !== central.length) throw new BackupError('ZIP 备份中央目录长度不一致')
  return declared
}

/** Incremental restore parser used by the file picker path. It reads the ZIP a chunk at a
 * time and writes every PDF/image directly to an app-owned OPFS staging file. The manifest
 * stays in memory because it must be structurally validated before any metadata commit.
 *
 * Archives produced by this app always put the manifest first. Requiring that ordering for
 * streaming restore prevents untrusted binary entries from being staged before validation.
 * The older single-JSON ZIP remains supported as long as it contains only that one entry. */
export async function parseBackupArchiveFileForRestore(file: Blob): Promise<{ backup: Backup; binaries?: BackupBinarySource }> {
  if (file.size > MAX_STREAM_ARCHIVE_BYTES) throw new BackupError('ZIP 备份超过 2 GB，超出当前版本支持的安全范围')
  if (typeof file.stream !== 'function') throw new BackupError('当前浏览器不支持流式读取大型备份，请升级浏览器后重试')
  const centralEntries = await validateStreamingZipEnvelope(file)

  let failure: unknown
  let work = Promise.resolve()
  const schedule = (fn: () => Promise<void> | void) => {
    work = work.then(async () => { if (!failure) await fn() }).catch(error => { if (!failure) failure = error })
  }
  const manifestParts: Uint8Array[] = []
  let manifestBytes = 0
  let backup: Backup | undefined
  let portable = false
  let entryCount = 0
  let outputBytes = 0
  const seenNames = new Set<string>()
  const expected = new Map<string, PortableEntrySpec>()
  const activeSinks = new Set<BinaryWriteSink>()
  const staged: StoredBinary[] = []
  const attachments = new Map<string, StoredBinary>()
  const documents = new Map<string, StoredBinary>()

  const parseManifest = () => {
    let json: unknown
    try {
      const merged = new Uint8Array(manifestBytes)
      let offset = 0
      for (const part of manifestParts) { merged.set(part, offset); offset += part.byteLength }
      json = JSON.parse(strFromU8(merged))
    } catch { throw new BackupError('ZIP 内的备份 JSON 无法解析') }
    manifestParts.length = 0
    if (!json || typeof json !== 'object' || (json as Record<string, unknown>).archiveFormat !== PORTABLE_ARCHIVE_FORMAT) {
      backup = parseAndValidate(json)
      return
    }

    const manifest = json as PortableBackupManifest
    if (manifest.archiveVersion !== 2 || !manifest.backup || !Array.isArray(manifest.backup.attachments) || !Array.isArray(manifest.backup.documents)) throw new BackupError('ZIP 备份清单格式不正确')
    portable = true
    const hydratedAttachments: BackupAttachment[] = manifest.backup.attachments.map(item => {
      if (!isSafeEntry(item.entry, 'attachments/') || expected.has(item.entry)) throw new BackupError('ZIP 附件路径不正确')
      expected.set(item.entry, { kind: 'attachments', id: item.id, mimeType: item.mimeType || item.meta.mimeType || 'application/octet-stream', expectedSize: centralEntries.get(item.entry) })
      return { id: item.id, meta: item.meta, mimeType: item.mimeType, data: 'AA==' }
    })
    const hydratedDocuments: BackupDocument[] = manifest.backup.documents.map(item => {
      if (!isSafeEntry(item.entry, 'documents/') || expected.has(item.entry)) throw new BackupError('ZIP 文档路径不正确')
      expected.set(item.entry, { kind: 'documents', id: item.id, mimeType: item.mimeType || 'application/pdf', expectedSize: centralEntries.get(item.entry) })
      return { id: item.id, meta: item.meta, mimeType: item.mimeType, data: 'AA==' }
    })
    backup = parseAndValidate({ ...manifest.backup, attachments: hydratedAttachments, documents: hydratedDocuments })
  }

  const unzip = new Unzip(entry => {
    entryCount++
    const name = entry.name
    if (entryCount > MAX_ENTRY_COUNT) schedule(() => { throw new BackupError('ZIP 备份文件数异常') })
    if (seenNames.has(name)) schedule(() => { throw new BackupError('ZIP 备份包含重复文件：' + name.slice(0, 80)) })
    seenNames.add(name)
    if (entryCount === 1 && name !== BACKUP_ARCHIVE_ENTRY) schedule(() => { throw new BackupError('流式 ZIP 备份必须以备份清单开头') })

    let sink: BinaryWriteSink | undefined
    entry.ondata = (error, chunk, final) => {
      const owned = chunk.byteLength ? chunk.slice() : chunk
      schedule(async () => {
        if (error) throw new BackupError('ZIP 备份已损坏或无法解压')
        outputBytes += owned.byteLength
        if (outputBytes > MAX_UNCOMPRESSED_BYTES) throw new BackupError('ZIP 备份解压后超过 1 GB，超出当前版本支持的安全范围')
        if (name === BACKUP_ARCHIVE_ENTRY) {
          manifestBytes += owned.byteLength
          if (manifestBytes > MAX_STREAM_MANIFEST_BYTES) throw new BackupError('ZIP 备份清单超过 256 MB')
          if (owned.byteLength) manifestParts.push(owned)
          if (final) parseManifest()
          return
        }
        if (!backup || !portable) throw new BackupError('ZIP 备份结构不正确')
        const spec = expected.get(name)
        if (!spec) throw new BackupError('ZIP 备份包含未声明的文件')
        if (!sink) {
          sink = await createBinaryWriteSink(spec.kind, spec.id, spec.mimeType)
          activeSinks.add(sink)
          if (file.size > MAX_ARCHIVE_BYTES && !sink.streamsToDisk) throw new BackupError('当前浏览器无法将大型备份直接写入磁盘存储，请使用最新版 Chrome、Edge、Firefox 或 Safari')
        }
        await sink.write(owned)
        if (final) {
          const ref = await sink.close()
          activeSinks.delete(sink)
          if (typeof spec.expectedSize === 'number' && ref.size !== spec.expectedSize) {
            await deleteBinary(ref).catch(() => undefined)
            throw new BackupError('ZIP 文件大小与清单不一致：' + name.slice(0, 80))
          }
          staged.push(ref)
          ;(spec.kind === 'attachments' ? attachments : documents).set(spec.id, ref)
          expected.delete(name)
        }
      })
    }
    try { entry.start() } catch (error) { schedule(() => { throw error }) }
  })
  unzip.register(UnzipInflate)

  try {
    const reader = file.stream().getReader()
    let compressedBytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) { unzip.push(new Uint8Array(0), true); break }
      compressedBytes += value.byteLength
      if (compressedBytes > MAX_STREAM_ARCHIVE_BYTES) throw new BackupError('ZIP 备份超过 2 GB，超出当前版本支持的安全范围')
      try { unzip.push(value) } catch { throw new BackupError('ZIP 备份已损坏或使用了不支持的压缩方式') }
      await work
      if (failure) throw failure
    }
    await work
    if (failure) throw failure
    if (!backup || entryCount === 0) throw new BackupError('ZIP 备份结构不正确')
    if (entryCount !== centralEntries.size) throw new BackupError('ZIP 备份条目数量与中央目录不一致')
    if (!portable) {
      if (entryCount !== 1) throw new BackupError('ZIP 备份结构不正确')
      return { backup }
    }
    if (expected.size) throw new BackupError('ZIP 备份缺少文件：' + [...expected.keys()][0].slice(0, 80))
    if (seenNames.size !== 1 + attachments.size + documents.size) throw new BackupError('ZIP 备份包含未声明的文件')
    return { backup, binaries: { attachments, documents } }
  } catch (error) {
    for (const sink of activeSinks) { try { await sink.abort() } catch { /* best effort */ } }
    for (const ref of staged) { try { await deleteBinary(ref) } catch { /* best effort */ } }
    if (error instanceof BackupError) throw error
    throw new BackupError(error instanceof Error && error.message ? error.message : 'ZIP 备份恢复失败')
  }
}

/** Restore-oriented parser. It validates the same manifest but keeps binary ZIP
 * entries as bytes, avoiding the extra binary-string + base64 copies made by the
 * compatibility parser above. Entries are consumed and deleted during restore. */
export function parseBackupArchiveForRestore(bytes: Uint8Array): { backup: Backup; binaries?: BackupBinarySource } {
  validateZipEnvelope(bytes)
  let files: Record<string, Uint8Array>
  try { files = unzipSync(bytes) } catch { throw new BackupError('ZIP 备份已损坏或无法解压') }
  const names = Object.keys(files)
  const data = files[BACKUP_ARCHIVE_ENTRY]
  if (!data || data.byteLength > MAX_UNCOMPRESSED_BYTES) throw new BackupError('ZIP 备份内容缺失或过大')
  let json: unknown
  try { json = JSON.parse(strFromU8(data)) } catch { throw new BackupError('ZIP 内的备份 JSON 无法解析') }
  if (!json || typeof json !== 'object' || (json as Record<string, unknown>).archiveFormat !== PORTABLE_ARCHIVE_FORMAT) {
    if (names.length !== 1) throw new BackupError('ZIP 备份结构不正确')
    return { backup: parseAndValidate(json) }
  }

  const manifest = json as PortableBackupManifest
  if (manifest.archiveVersion !== 2 || !manifest.backup || !Array.isArray(manifest.backup.attachments) || !Array.isArray(manifest.backup.documents)) throw new BackupError('ZIP 备份清单格式不正确')
  const expected = new Set([BACKUP_ARCHIVE_ENTRY])
  const attachments = new Map<string, Uint8Array>()
  const documents = new Map<string, Uint8Array>()
  const hydratedAttachments: BackupAttachment[] = manifest.backup.attachments.map(item => {
    if (!isSafeEntry(item.entry, 'attachments/') || expected.has(item.entry)) throw new BackupError('ZIP 附件路径不正确')
    expected.add(item.entry)
    const entry = files[item.entry]
    if (!entry) throw new BackupError('ZIP 备份缺少附件：' + item.id.slice(0, 8))
    attachments.set(item.id, entry)
    delete files[item.entry]
    return { id: item.id, meta: item.meta, mimeType: item.mimeType, data: 'AA==' }
  })
  const hydratedDocuments: BackupDocument[] = manifest.backup.documents.map(item => {
    if (!isSafeEntry(item.entry, 'documents/') || expected.has(item.entry)) throw new BackupError('ZIP 文档路径不正确')
    expected.add(item.entry)
    const entry = files[item.entry]
    if (!entry) throw new BackupError('ZIP 备份缺少文档：' + item.id.slice(0, 8))
    documents.set(item.id, entry)
    delete files[item.entry]
    return { id: item.id, meta: item.meta, mimeType: item.mimeType, data: 'AA==' }
  })
  delete files[BACKUP_ARCHIVE_ENTRY]
  if (Object.keys(files).length > 0 || expected.size !== names.length) throw new BackupError('ZIP 备份包含未声明的文件')
  const backup = parseAndValidate({ ...manifest.backup, attachments: hydratedAttachments, documents: hydratedDocuments })
  return { backup, binaries: { attachments, documents } }
}

export function isBackupArchive(bytes: Uint8Array): boolean { return hasZipMagic(bytes) }
