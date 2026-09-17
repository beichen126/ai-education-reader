import { strFromU8, strToU8, unzipSync, zipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { BackupError, parseAndValidate } from './backup-import'
import { PORTABLE_ARCHIVE_FORMAT, type Backup, type BackupAttachment, type BackupDocument, type PortableBackupManifest } from './backup-types'
import type { PortableBackupPlan } from './backup-export'

export const BACKUP_ARCHIVE_ENTRY = 'ai-education-reader-backup.json'
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024
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

async function pushBlob(file: ZipPassThrough, blob: Blob): Promise<void> {
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength) file.push(value)
    }
    file.push(new Uint8Array(0), true)
    return
  }
  const chunkSize = 1024 * 1024
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    file.push(new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()))
  }
  file.push(new Uint8Array(0), true)
}

/** ZIP v2 keeps large PDF/image bytes outside JSON and consumes one Blob stream at a time.
 * Peak memory is therefore the compressed archive plus a small stream chunk, rather than
 * base64 JSON + UTF-16 JSON + zipSync input + zipSync output. */
export async function buildPortableBackupArchive(plan: PortableBackupPlan): Promise<Blob> {
  const safeSettings = { ...(plan.manifest.backup.settings as Record<string, unknown>) }
  delete safeSettings.apiKey
  const manifest: PortableBackupManifest = {
    ...plan.manifest,
    backup: { ...plan.manifest.backup, settings: safeSettings as PortableBackupManifest['backup']['settings'] },
  }
  const parts: BlobPart[] = []
  let resolveDone!: (blob: Blob) => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<Blob>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const zip = new Zip((error, chunk, final) => {
    if (error) { rejectDone(error); return }
    if (chunk.byteLength) parts.push(chunk.slice().buffer)
    if (final) resolveDone(new Blob(parts, { type: 'application/zip' }))
  })
  try {
    const meta = new ZipDeflate(BACKUP_ARCHIVE_ENTRY, { level: 6 })
    zip.add(meta)
    meta.push(strToU8(JSON.stringify(manifest)), true)
    for (const binary of plan.binaries) {
      const file = new ZipPassThrough(binary.entry)
      zip.add(file)
      await pushBlob(file, binary.blob)
    }
    zip.end()
  } catch (error) {
    zip.terminate()
    rejectDone(error)
  }
  return done
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

export function isBackupArchive(bytes: Uint8Array): boolean { return hasZipMagic(bytes) }
