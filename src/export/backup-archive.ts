import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { BackupError, parseAndValidate } from './backup-import'
import type { Backup } from './backup-types'

export const BACKUP_ARCHIVE_ENTRY = 'ai-education-reader-backup.json'
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024
const MAX_ENTRY_COUNT = 16

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

export function parseBackupArchive(bytes: Uint8Array): Backup {
  validateZipEnvelope(bytes)
  let files: Record<string, Uint8Array>
  try { files = unzipSync(bytes) } catch { throw new BackupError('ZIP 备份已损坏或无法解压') }
  const names = Object.keys(files)
  if (names.length !== 1 || names[0] !== BACKUP_ARCHIVE_ENTRY) throw new BackupError('ZIP 备份结构不正确')
  const data = files[BACKUP_ARCHIVE_ENTRY]
  if (!data || data.byteLength > MAX_UNCOMPRESSED_BYTES) throw new BackupError('ZIP 备份内容缺失或过大')
  let json: unknown
  try { json = JSON.parse(strFromU8(data)) } catch { throw new BackupError('ZIP 内的备份 JSON 无法解析') }
  return parseAndValidate(json)
}

export function isBackupArchive(bytes: Uint8Array): boolean { return hasZipMagic(bytes) }
