import { buildBackup, buildPortableBackupPlan } from './backup-export'
import { parseAndValidate, restoreBackup, BackupError } from './backup-import'
import { conversationMarkdown, markedOnlyMarkdown } from './markdown'
import { downloadText, downloadJson, downloadBlob } from './download'
import { buildConversationBundle, ConversationBundleError } from './conversation-bundle'
import { buildPortableBackupArchive, isBackupArchive, MAX_ARCHIVE_BYTES, parseBackupArchiveForRestore, writePortableBackupArchive } from './backup-archive'
import { writeBookmarkedPdf, PdfOutlineError } from './pdf-outline-writer'
import { readDocumentSourceBlob } from '../documents/document-service'
import type { ChapterNode } from '../documents/document-types'
import { getConversation, getAnnotationsByConversation } from '../storage/storage'
import { initStore } from '../engine/sessions-store'
import { initSettings } from '../engine/settings-store'
import { clearAnnotationCache } from '../annotations/annotation-store'
import { resetDrafts } from '../engine/draft-store'
import { migrateLegacyPrompts } from '../prompts/prompt-migration'
import { migratePromptSimplification } from '../prompts/prompt-simplification'
import { initLayout } from '../engine/layout-store'

export { BackupError, PdfOutlineError, ConversationBundleError }
export type { BackupV1, BackupAttachment } from './backup-types'

function stamp(): string { return new Date().toISOString().slice(0, 10) }
function safeName(t: string): string { return (String(t || '').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'conversation').slice(0, 40) }

export async function exportBackupJson(): Promise<void> {
  const backup = await buildBackup()
  downloadJson('ai-education-reader-backup-' + stamp() + '.json', backup)
}
export async function exportBackupZip(): Promise<{ fileName: string; estimatedBytes: number }> {
  const fileName = 'ai-education-reader-backup-' + stamp() + '.zip'
  const picker = (globalThis as typeof globalThis & {
    showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{
      createWritable: () => Promise<{ write: (data: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }>
    }>
  }).showSaveFilePicker
  const plan = await buildPortableBackupPlan()
  const estimatedBytes = plan.binaries.reduce((sum, item) => sum + item.blob.size, 0)
  // Keep the familiar one-click download for ordinary backups. For large data,
  // Chromium/Edge writes each compressed chunk straight to disk instead of
  // retaining the complete archive in the JS heap.
  const handle = typeof picker === 'function' && estimatedBytes > 64 * 1024 * 1024
    ? await picker({ suggestedName: fileName, types: [{ description: 'ZIP backup', accept: { 'application/zip': ['.zip'] } }] })
    : undefined
  if (handle) {
    const writable = await handle.createWritable()
    try {
      await writePortableBackupArchive(plan, chunk => writable.write(chunk))
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => undefined)
      throw error
    }
    return { fileName, estimatedBytes }
  }
  if (estimatedBytes > 256 * 1024 * 1024) throw new BackupError('当前浏览器不支持流式保存，备份超过 256 MB。请使用最新版 Chrome 或 Edge 导出，避免内存不足。')
  downloadBlob(fileName, await buildPortableBackupArchive(plan))
  return { fileName, estimatedBytes }
}
export async function exportConversationMd(convId: string): Promise<void> {
  const conv = await getConversation(convId); if (!conv) return
  const anns = await getAnnotationsByConversation(convId)
  downloadText(safeName(conv.title) + '.md', conversationMarkdown(conv, anns), 'text/markdown')
}
export async function exportMarkedOnlyMd(convId: string): Promise<void> {
  const conv = await getConversation(convId); if (!conv) return
  const anns = await getAnnotationsByConversation(convId)
  downloadText(safeName(conv.title) + '-marked.md', markedOnlyMarkdown(conv, anns), 'text/markdown')
}
export async function exportConversationBundle(convId: string): Promise<void> {
  const bundle = await buildConversationBundle(convId)
  downloadBlob(bundle.zipName, bundle.blob)
}
export async function exportBookmarkedPdf(opts: { id: string; fileName: string; pageCount: number; chapters: ChapterNode[]; resolveFileName?: string }): Promise<void> {
  let blob: Blob
  try { blob = await readDocumentSourceBlob(opts.id) } catch { throw new PdfOutlineError('本地文件数据已丢失，无法导出。') }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const out = await writeBookmarkedPdf({ sourceBytes: bytes, chapters: opts.chapters, pageCount: opts.pageCount })
  downloadBlob(opts.resolveFileName || (safeName(opts.fileName).replace(/\.pdf$/i, '') + '-带目录.pdf'), new Blob([out as unknown as BlobPart], { type: 'application/pdf' }))
}

export async function importBackupText(text: string): Promise<void> {
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new BackupError('JSON 解析失败') }
  const backup = parseAndValidate(json)
  await restoreBackup(backup)
  // A restore replaces all local data (including draft:<id> settings rows), so drop
  // the in-memory draft cache before initStore reloads from the restored settings.
  resetDrafts()
  await migrateLegacyPrompts()
  await migratePromptSimplification()
  await initSettings()
  await initLayout()
  await initStore()
  clearAnnotationCache()
}

export async function importBackupFile(file: File): Promise<void> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new BackupError('备份文件超过 512 MB，当前浏览器无法安全地在内存中恢复。')
  let bytes = new Uint8Array(await file.arrayBuffer())
  if (isBackupArchive(bytes)) {
    const parsed = parseBackupArchiveForRestore(bytes)
    bytes = new Uint8Array(0)
    await restoreBackup(parsed.backup, parsed.binaries)
    resetDrafts()
    await migrateLegacyPrompts()
    await migratePromptSimplification()
    await initSettings()
    await initLayout()
    await initStore()
    clearAnnotationCache()
    return
  }
  await importBackupText(new TextDecoder().decode(bytes))
}
