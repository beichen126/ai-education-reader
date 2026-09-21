import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { buildBackupArchive, buildPortableBackupArchive, parseBackupArchiveFileForRestore } from '../src/export/backup-archive.ts'
import { restoreBackup } from '../src/export/backup-import.ts'
import { DEFAULT_PROMPT_PREFERENCES } from '../src/prompts/prompt-preferences.ts'
import { readBinary, type OpfsFileSystem } from '../src/storage/binary-store.ts'
import { closeDb, idbClearAll } from '../src/storage/idb.ts'
import { getAttachmentRow } from '../src/storage/storage.ts'

const files = new Map<string, Blob>()
let incrementalWrites = 0
const mock: OpfsFileSystem = {
  async read(path) { const blob = files.get(path); if (!blob) throw new Error('missing'); return blob },
  async write(path, blob) { files.set(path, blob) },
  async delete(path) { files.delete(path) },
  async exists(path) { return files.has(path) },
  async listAppFiles() { return [...files.entries()].map(([path, blob]) => ({ path, size: blob.size, lastModified: 1 })) },
  async clearAppRoot() { files.clear(); return { completed: true, failedPaths: [] } },
  async createWriter(path) {
    const parts: BlobPart[] = []
    return {
      async write(chunk) { incrementalWrites++; parts.push(chunk.slice().buffer as ArrayBuffer) },
      async close() { files.set(path, new Blob(parts)) },
      async abort() { files.delete(path) },
    }
  },
}
;(globalThis as any).__dshOpfsMock = mock

const attachmentBytes = new Uint8Array(2 * 1024 * 1024 + 17)
for (let i = 0; i < attachmentBytes.length; i++) attachmentBytes[i] = i % 251
const attachment = { id: 'attachment-1', name: 'large.png', mimeType: 'image/png', size: attachmentBytes.length, createdAt: 1, updatedAt: 1 }
const manifest = {
  archiveFormat: 'ai-education-reader-portable-zip' as const,
  archiveVersion: 2 as const,
  backup: {
    format: 'ai-education-reader-backup' as const,
    version: 7 as const,
    exportedAt: 1,
    settings: { apiBaseUrl: 'https://example.invalid', model: 'model', customSystemPrompt: '', customSystemPromptEnabled: false },
    conversations: [], annotations: [],
    attachments: [{ id: attachment.id, meta: attachment, mimeType: attachment.mimeType, entry: 'attachments/attachment-1.bin' }],
    documents: [], documentNotes: [], drafts: [], appearance: 'system' as const,
    branches: [], branchDrafts: [], artifacts: [], activeBranches: [], prompts: [],
    promptPreferences: { ...DEFAULT_PROMPT_PREFERENCES }, studyCards: [],
  },
}

const archive = await buildPortableBackupArchive({
  manifest,
  binaries: [{ entry: 'attachments/attachment-1.bin', blob: new Blob([attachmentBytes], { type: 'image/png' }) }],
})
const parsed = await parseBackupArchiveFileForRestore(archive)
assert.equal(parsed.backup.version, 7)
const stored = parsed.binaries?.attachments.get(attachment.id)
assert(stored && !(stored instanceof Uint8Array) && stored.storage === 'opfs')
assert.equal(stored.size, attachmentBytes.length)
assert(incrementalWrites > 0, 'portable entry must use the incremental OPFS writer')
const restored = new Uint8Array(await (await mock.read(stored.path)).arrayBuffer())
assert.deepEqual(restored, attachmentBytes)
await idbClearAll()
await restoreBackup(parsed.backup, parsed.binaries)
const restoredRow = await getAttachmentRow(attachment.id)
assert(restoredRow?.binary, 'streamed binary reference must commit with restored metadata')
assert.deepEqual(new Uint8Array(await (await readBinary(restoredRow.binary)).arrayBuffer()), attachmentBytes)

// Old one-entry ZIP backups still use the same streaming file-reader path.
const legacy = {
  format: 'ai-education-reader-backup' as const,
  version: 1 as const,
  exportedAt: 1,
  settings: { apiBaseUrl: 'https://example.invalid', model: 'model', customSystemPrompt: '', customSystemPromptEnabled: false },
  conversations: [], annotations: [], attachments: [],
}
const legacyParsed = await parseBackupArchiveFileForRestore(buildBackupArchive(legacy))
assert.equal(legacyParsed.backup.version, 1)
assert.equal(legacyParsed.binaries, undefined)
const legacyBytes = new Uint8Array(await buildBackupArchive(legacy).arrayBuffer())
await assert.rejects(
  () => parseBackupArchiveFileForRestore(new Blob([legacyBytes.slice(0, -22)])),
  /中央目录|损坏|不完整/,
  'a ZIP truncated after its local entries must never be accepted',
)

// Legacy metadata could contain a stale display size; ZIP structural size remains authoritative.
const legacySizeManifest = structuredClone(manifest)
legacySizeManifest.backup.attachments[0].meta.size++
const legacySizeArchive = await buildPortableBackupArchive({
  manifest: legacySizeManifest,
  binaries: [{ entry: 'attachments/attachment-1.bin', blob: new Blob([attachmentBytes], { type: 'image/png' }) }],
})
const legacySizeParsed = await parseBackupArchiveFileForRestore(legacySizeArchive)
assert(legacySizeParsed.binaries?.attachments.has(attachment.id), 'stale legacy display size remains importable')

const filesBeforeFailedParse = files.size
const unexpectedEntryArchive = await buildPortableBackupArchive({
  manifest,
  binaries: [
    { entry: 'attachments/attachment-1.bin', blob: new Blob([attachmentBytes], { type: 'image/png' }) },
    { entry: 'attachments/unexpected.bin', blob: new Blob([new Uint8Array([1, 2, 3])]) },
  ],
})
await assert.rejects(() => parseBackupArchiveFileForRestore(unexpectedEntryArchive), /未声明的文件/)
assert.equal(files.size, filesBeforeFailedParse, 'a failed parse removes binaries staged earlier in the same archive')

;(globalThis as any).__dshOpfsMock = undefined
await closeDb()
console.log('streaming backup import: PASS')
