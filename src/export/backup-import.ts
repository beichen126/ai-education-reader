import { idbReplaceAll } from '../storage/idb'
import type { Annotation } from '../annotations/annotation-types'
import { ANNOTATION_VERSION } from '../annotations/annotation-types'
import type { Attachment } from '../engine/types'
import { BACKUP_FORMAT, LEGACY_BACKUP_FORMAT, BACKUP_VERSION, type Backup, type BackupV1, type BackupV2 } from './backup-types'

export class BackupError extends Error { constructor(message: string) { super(message); this.name = 'BackupError' } }

function isObj(v: unknown): v is Record<string, any> { return typeof v === 'object' && v !== null && !Array.isArray(v) }
function isStr(v: unknown): v is string { return typeof v === 'string' }
function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) }
function isNonEmptyStr(v: unknown): v is string { return isStr(v) && v.length > 0 }
function isInt(v: unknown): v is number { return isNum(v) && Number.isInteger(v) }

const VALID_ROLES = new Set(['user', 'assistant'])
const VALID_ANNOT_TYPES = new Set(['text', 'table', 'table-cells', 'math'])
const VALID_MATH_KINDS = new Set(['inline', 'block'])
const VALID_ANCHOR_SCOPES = new Set(['block', 'table-cell'])
const VALID_CHAPTER_SOURCES = new Set(['native', 'ai-toc', 'manual'])
const VALID_DOC_CHAPTER_SOURCES = new Set(['none', 'native', 'ai-toc', 'manual', 'mixed'])

/** Standard base64 (with padding) that atob can decode. */
function isBase64(data: unknown): boolean {
  if (!isStr(data) || data.length === 0 || data.length % 4 !== 0) return false
  try { atob(data); return true } catch { return false }
}

function validateChapterTree(c: unknown, pageCount: number, depth: number): boolean {
  if (!isObj(c)) return false
  if (!isNonEmptyStr(c.id) || !isStr(c.title) || !isInt(c.level) || c.level < 1) return false
  if (!VALID_CHAPTER_SOURCES.has(c.source)) return false
  if (typeof c.selectable !== 'boolean') return false
  const inRange = (p: unknown) => p === null || (isInt(p) && p >= 1 && p <= pageCount)
  if (!inRange(c.startPage) || !inRange(c.endPage)) return false
  if (isInt(c.startPage) && isInt(c.endPage) && c.endPage < c.startPage) return false
  if (depth > 24 || !Array.isArray(c.children)) return false
  return c.children.every((ch: unknown) => validateChapterTree(ch, pageCount, depth + 1))
}

function validateDocuments(input: Record<string, any>): void {
  if (input.version === 1) return // V1 never carries documents; legacy restores with documents=[]
  if (!Array.isArray(input.documents)) throw new BackupError('缺少 documents 数组')
  const ids = new Set<string>()
  for (const d of input.documents) {
    if (!isObj(d) || !isNonEmptyStr(d.id)) throw new BackupError('document 缺少合法的 id')
    if (ids.has(d.id)) throw new BackupError('document id 重复：' + d.id.slice(0, 8))
    ids.add(d.id)
    if (!isObj(d.meta) || d.meta.id !== d.id) throw new BackupError('document.meta.id 必须与 d.id 一致')
    const m = d.meta
    if (m.kind !== 'pdf') throw new BackupError('document.kind 非法')
    if (m.mimeType !== 'application/pdf') throw new BackupError('document.mimeType 非法')
    if (!isNonEmptyStr(m.fileName)) throw new BackupError('document.fileName 非法')
    if (!isNum(m.fileSize) || m.fileSize < 0) throw new BackupError('document.fileSize 非法')
    if (!isInt(m.pageCount) || m.pageCount < 1) throw new BackupError('document.pageCount 非法')
    if (!isNum(m.lastReadPage) || m.lastReadPage < 0) throw new BackupError('document.lastReadPage 非法')
    if (!isNum(m.createdAt) || !isNum(m.updatedAt)) throw new BackupError('document 时间戳必须是数字')
    if (!VALID_DOC_CHAPTER_SOURCES.has(m.chapterSource)) throw new BackupError('document.chapterSource 非法')
    if (!Array.isArray(m.chapters) || !m.chapters.every((c: unknown) => validateChapterTree(c, m.pageCount, 0))) throw new BackupError('document.chapters 非法（章节页码/层级/结构不合法）')
    if (d.mimeType !== 'application/pdf') throw new BackupError('document 的 mimeType 必须是 application/pdf')
    if (!isBase64(d.data)) throw new BackupError('document.data 不是合法的 base64')
  }
}

/**
 * Parse + validate an external backup. Throws BackupError with a human-readable
 * reason on ANY failure, BEFORE anything is written — so a malformed or malicious
 * backup can never clear/overwrite the current database. Accepts V1 (Stage 4-9.3)
 * and V2 (Stage 9.2A+) backups; V1 restores with an empty document library.
 */
export function parseAndValidate(input: unknown): Backup {
  if (!isObj(input)) throw new BackupError('不是一个有效的备份对象')
  if (input.format !== BACKUP_FORMAT && input.format !== LEGACY_BACKUP_FORMAT) throw new BackupError('格式不匹配：不是本产品的备份文件（支持 ' + BACKUP_FORMAT + ' 与 ' + LEGACY_BACKUP_FORMAT + '）')
  if (input.version !== 1 && input.version !== 2) throw new BackupError('版本不支持：当前仅支持 v1 / v2')
  if (!Array.isArray(input.conversations)) throw new BackupError('缺少 conversations 数组')
  if (!Array.isArray(input.annotations)) throw new BackupError('缺少 annotations 数组')
  if (!Array.isArray(input.attachments)) throw new BackupError('缺少 attachments 数组')

  const settings = isObj(input.settings) ? input.settings : {}
  if (settings.apiBaseUrl !== undefined && !isStr(settings.apiBaseUrl)) throw new BackupError('settings.apiBaseUrl 必须是字符串')
  if (settings.model !== undefined && !isStr(settings.model)) throw new BackupError('settings.model 必须是字符串')

  const convIds = new Set<string>()
  const attIds = new Set<string>()
  const messageIds = new Map<string, Set<string>>()   // conversationId -> message ids

  // --- conversations + messages ---
  for (const c of input.conversations) {
    if (!isObj(c) || !isNonEmptyStr(c.id)) throw new BackupError('conversation 缺少合法的 id')
    if (!isStr(c.title)) throw new BackupError('conversation.title 必须是字符串')
    if (!isNum(c.createdAt) || !isNum(c.updatedAt)) throw new BackupError('conversation 时间戳必须是数字')
    if (!Array.isArray(c.messages)) throw new BackupError('conversation 缺少 messages 数组')
    convIds.add(c.id)
    const mids = new Set<string>()
    for (const m of c.messages) {
      if (!isObj(m) || !isNonEmptyStr(m.id)) throw new BackupError('message 缺少合法的 id')
      if (!VALID_ROLES.has(m.role)) throw new BackupError('message.role 必须是 user / assistant')
      if (!isStr(m.content)) throw new BackupError('message.content 必须是字符串')
      if (!Array.isArray(m.images) || !m.images.every(isStr)) throw new BackupError('message.images 必须是字符串数组')
      if (!isNum(m.createdAt) || !isNum(m.updatedAt)) throw new BackupError('message 时间戳必须是数字')
      mids.add(m.id)
    }
    messageIds.set(c.id, mids)
  }

  // --- attachments ---
  for (const at of input.attachments) {
    if (!isObj(at) || !isNonEmptyStr(at.id)) throw new BackupError('attachment 缺少合法的 id')
    if (!isObj(at.meta) || at.meta.id !== at.id) throw new BackupError('attachment.meta.id 必须与 at.id 一致')
    if (!isStr(at.mimeType) || !/^image\//.test(at.mimeType)) throw new BackupError('attachment.mimeType 非法')
    if (!isBase64(at.data)) throw new BackupError('attachment.data 不是合法的 base64')
    attIds.add(at.id)
  }

  // --- annotations (type-specific + reference consistency) ---
  for (const a of input.annotations) {
    if (!isObj(a) || !isNonEmptyStr(a.id)) throw new BackupError('annotation 缺少合法的 id')
    if (a.version !== ANNOTATION_VERSION) throw new BackupError('annotation.version 非法')
    if (!isNonEmptyStr(a.conversationId)) throw new BackupError('annotation.conversationId 非法')
    if (!isNonEmptyStr(a.messageId)) throw new BackupError('annotation.messageId 非法')
    if (!convIds.has(a.conversationId)) throw new BackupError('annotation 引用了不存在的会话')
    const mids = messageIds.get(a.conversationId) ?? new Set<string>()
    if (!mids.has(a.messageId)) throw new BackupError('annotation 引用了不存在的消息')
    if (!isObj(a.target)) throw new BackupError('annotation.target 非法')
    const t = a.target
    if (!VALID_ANNOT_TYPES.has(t.type)) throw new BackupError('annotation.target.type 不在支持集合')
    if (t.type === 'text') {
      if (!isObj(t.anchor) || !VALID_ANCHOR_SCOPES.has(t.anchor.scope)) throw new BackupError('text 标注 anchor 非法')
      if (t.anchor.scope === 'block' && !isNonEmptyStr(t.anchor.blockId)) throw new BackupError('block anchor 缺少 blockId')
      if (t.anchor.scope === 'table-cell') {
        if (!isNonEmptyStr(t.anchor.tableId) || !isNum(t.anchor.row) || !isNum(t.anchor.column)) throw new BackupError('table-cell anchor 非法')
      }
      if (!isNum(t.start) || !isNum(t.end) || t.start < 0 || t.end < t.start) throw new BackupError('text 标注 start/end 非法')
      if (!isObj(t.quote) || !isStr(t.quote.exact)) throw new BackupError('text 标注 quote 非法')
    } else if (t.type === 'table') {
      if (!isNonEmptyStr(t.tableId)) throw new BackupError('table 标注缺少 tableId')
    } else if (t.type === 'table-cells') {
      if (!isNonEmptyStr(t.tableId)) throw new BackupError('table-cells 标注缺少 tableId')
      if (!isObj(t.bounds)) throw new BackupError('table-cells 标注缺少 bounds')
      const b = t.bounds
      if (!isNum(b.rowStart) || !isNum(b.rowEnd) || !isNum(b.columnStart) || !isNum(b.columnEnd)) throw new BackupError('table-cells bounds 非法')
      if (b.rowStart < 0 || b.columnStart < 0 || b.rowEnd < b.rowStart || b.columnEnd < b.columnStart) throw new BackupError('table-cells bounds 越界')
    } else if (t.type === 'math') {
      if (!isNonEmptyStr(t.mathId) || !VALID_MATH_KINDS.has(t.mathKind)) throw new BackupError('math 标注非法')
    }
  }

  // --- message.images -> attachment exists (reference consistency) ---
  for (const c of input.conversations) {
    for (const m of c.messages) {
      for (const img of m.images) {
        if (!attIds.has(img)) throw new BackupError('message 引用了不存在的附件：' + String(img).slice(0, 8))
      }
    }
  }

  validateDocuments(input)
  return input as Backup
}

function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime || 'application/octet-stream' })
}

/** Atomic replace-restore: decode attachments + documents then write every store in ONE readwrite transaction. */
export async function restoreBackup(backup: Backup): Promise<void> {
  const attachments = backup.attachments.map((at) => ({ id: at.id, meta: at.meta as Attachment, blob: base64ToBlob(at.data, at.mimeType || at.meta.mimeType) }))
  const v2 = 'documents' in backup ? (backup as BackupV2) : null
  const documents = v2 ? v2.documents.map((d) => ({ ...d.meta, sourceBlob: base64ToBlob(d.data, d.mimeType) })) : []
  const settings = [
    { key: 'apiBaseUrl', value: backup.settings?.apiBaseUrl || 'https://api.deepseek.com' },
    { key: 'model', value: backup.settings?.model || 'deepseek-chat' },
    { key: 'customSystemPrompt', value: backup.settings?.customSystemPrompt || '' },
    { key: 'customSystemPromptEnabled', value: backup.settings?.customSystemPromptEnabled ? 'true' : 'false' },
    { key: 'apiKey', value: '' },
  ]
  await idbReplaceAll({ settings, conversations: backup.conversations, attachments, annotations: backup.annotations as Annotation[], documents })
}
