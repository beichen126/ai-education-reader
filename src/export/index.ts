import { buildBackup } from './backup-export'
import { parseAndValidate, restoreBackup, BackupError } from './backup-import'
import { conversationMarkdown, markedOnlyMarkdown } from './markdown'
import { downloadText, downloadJson } from './download'
import { getConversation, getAnnotationsByConversation } from '../storage/storage'
import { initStore } from '../engine/sessions-store'
import { initSettings } from '../engine/settings-store'
import { clearAnnotationCache } from '../annotations/annotation-store'
import { resetDrafts } from '../engine/draft-store'

export { BackupError }
export type { BackupV1, BackupAttachment } from './backup-types'

function stamp(): string { return new Date().toISOString().slice(0, 10) }
function safeName(t: string): string { return (String(t || '').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'conversation').slice(0, 40) }

export async function exportBackupJson(): Promise<void> {
  const backup = await buildBackup()
  downloadJson('dsh-eink-backup-' + stamp() + '.json', backup)
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
