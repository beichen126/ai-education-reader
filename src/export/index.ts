import { buildBackup } from './backup-export'
import { parseAndValidate, restoreBackup, BackupError } from './backup-import'
import { conversationMarkdown, markedOnlyMarkdown } from './markdown'
import { downloadText, downloadJson, downloadBlob } from './download'
import { writeBookmarkedPdf, PdfOutlineError } from './pdf-outline-writer'
import { readDocumentSourceBlob } from '../documents/document-service'
import type { ChapterNode } from '../documents/document-types'
import { getConversation, getAnnotationsByConversation } from '../storage/storage'
import { initStore } from '../engine/sessions-store'
import { initSettings } from '../engine/settings-store'
import { clearAnnotationCache } from '../annotations/annotation-store'
import { resetDrafts } from '../engine/draft-store'

export { BackupError, PdfOutlineError }
export type { BackupV1, BackupAttachment } from './backup-types'

function stamp(): string { return new Date().toISOString().slice(0, 10) }
function safeName(t: string): string { return (String(t || '').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'conversation').slice(0, 40) }

export async function exportBackupJson(): Promise<void> {
  const backup = await buildBackup()
  downloadJson('ai-education-reader-backup-' + stamp() + '.json', backup)
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
  await initSettings()
  await initStore()
  clearAnnotationCache()
}