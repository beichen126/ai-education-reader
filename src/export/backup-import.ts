import { idbReplaceAll, idbGetAll } from '../storage/idb'
import type { Annotation } from '../annotations/annotation-types'
import { ANNOTATION_VERSION } from '../annotations/annotation-types'
import type { Attachment } from '../engine/types'
import { persistBinary, deleteBinary, type StoredBinary } from '../storage/binary-store'
import { BACKUP_FORMAT, LEGACY_BACKUP_FORMAT, BACKUP_VERSION, type Backup, type BackupV1, type BackupV2, type BackupV3, type BackupV4, type BackupDraft, type BackupBranchDraft, type BackupActiveBranch, type BackupAppearance } from './backup-types'
import { validateBranchGraph } from '../branches/branch-path'
import { validateArtifact, validateQuizDocument } from '../artifacts/artifact-validation'
import type { ConversationBranch } from '../branches/branch-types'
import type { StudyArtifact } from '../artifacts/artifact-types'

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
const VALID_IMPORT_KINDS = new Set(['pdf', 'ppt', 'pptx'])
const VALID_DOC_CHAPTER_SOURCES = new Set(['none', 'native', 'ai-toc', 'manual', 'mixed'])
const VALID_APPEARANCE = new Set(['system', 'light', 'dark'])

function isBase64(data: unknown): boolean {
  if (!isStr(data) || data.length === 0 || data.length % 4 !== 0) return false
  try { atob(data); return true } catch { return false }
}

function validateChapterTree(c: unknown, pageCount: number, depth: number, ids: Set<string>): boolean {
  if (!isObj(c)) return false
  if (!isNonEmptyStr(c.id) || !isStr(c.title) || !isInt(c.level) || c.level < 1) return false
  if (ids.has(c.id)) return false
  ids.add(c.id)
  if (!VALID_CHAPTER_SOURCES.has(c.source)) return false
  if (typeof c.selectable !== 'boolean') return false
  const inRange = (p: unknown) => p === null || (isInt(p) && p >= 1 && p <= pageCount)
  if (!inRange(c.startPage) || !inRange(c.endPage)) return false
  if (isInt(c.startPage) && isInt(c.endPage) && c.endPage < c.startPage) return false
  if (depth > 24 || !Array.isArray(c.children)) return false
  return c.children.every((ch: unknown) => validateChapterTree(ch, pageCount, depth + 1, ids))
}

function validateDocuments(input: Record<string, any>): void {
  if (input.version === 1) return
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
    if (!isInt(m.fileSize) || m.fileSize < 0) throw new BackupError('document.fileSize 必须是 >= 0 的整数')
    if (!isInt(m.pageCount) || m.pageCount < 1) throw new BackupError('document.pageCount 非法')
    const okLastRead = m.lastReadPage === 0 || (isInt(m.lastReadPage) && m.lastReadPage >= 1 && m.lastReadPage <= m.pageCount)
    if (!okLastRead) throw new BackupError('document.lastReadPage 非法（0 或 1..pageCount 的整数）')
    if (m.lastReadAt !== undefined && !isNum(m.lastReadAt)) throw new BackupError('document.lastReadAt 必须是数字')
    if (m.contentHash !== undefined && !isStr(m.contentHash)) throw new BackupError('document.contentHash 非法')
    if (m.fastFingerprint !== undefined && !isStr(m.fastFingerprint)) throw new BackupError('document.fastFingerprint 非法')
    if (m.lastReadAt !== undefined && m.lastReadAt < 0) throw new BackupError('document.lastReadAt 不能为负')
    if (!isNum(m.createdAt) || !isNum(m.updatedAt)) throw new BackupError('document 时间戳必须是数字')
    if (!VALID_DOC_CHAPTER_SOURCES.has(m.chapterSource)) throw new BackupError('document.chapterSource 非法')
    if (m.importSource !== undefined) {
      const imp = m.importSource
      if (!isObj(imp) || !VALID_IMPORT_KINDS.has(imp.kind) || !isNonEmptyStr(imp.originalFileName) || imp.originalFileName.trim().length === 0) throw new BackupError('document.importSource 非法')
    }
    const chapterIds = new Set<string>()
    if (!Array.isArray(m.chapters) || !m.chapters.every((c: unknown) => validateChapterTree(c, m.pageCount, 0, chapterIds))) throw new BackupError('document.chapters 非法（章节页码/层级/结构/id 不合法）')
    if (d.mimeType !== 'application/pdf') throw new BackupError('document 的 mimeType 必须是 application/pdf')
    if (!isBase64(d.data)) throw new BackupError('document.data 不是合法的 base64')
  }
}

export function parseAndValidate(input: unknown): Backup {
  if (!isObj(input)) throw new BackupError('不是一个有效的备份对象')
  if (input.format !== BACKUP_FORMAT && input.format !== LEGACY_BACKUP_FORMAT) throw new BackupError('格式不匹配：不是本产品的备份文件（支持 ' + BACKUP_FORMAT + ' 与 ' + LEGACY_BACKUP_FORMAT + '）')
  if (input.version !== 1 && input.version !== 2 && input.version !== 3 && input.version !== 4) throw new BackupError('版本不支持：当前仅支持 v1 / v2 / v3 / v4')
  const isV3 = input.version === 3
  const isV4 = input.version === 4
  if (!Array.isArray(input.conversations)) throw new BackupError('缺少 conversations 数组')
  if (!Array.isArray(input.annotations)) throw new BackupError('缺少 annotations 数组')
  if (!Array.isArray(input.attachments)) throw new BackupError('缺少 attachments 数组')

  const settings = isObj(input.settings) ? input.settings : {}
  if (settings.apiBaseUrl !== undefined && !isStr(settings.apiBaseUrl)) throw new BackupError('settings.apiBaseUrl 必须是字符串')
  if (settings.model !== undefined && !isStr(settings.model)) throw new BackupError('settings.model 必须是字符串')

  const convIds = new Set<string>()
  const attIds = new Set<string>()
  const messageIds = new Map<string, Set<string>>()

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

  for (const at of input.attachments) {
    if (!isObj(at) || !isNonEmptyStr(at.id)) throw new BackupError('attachment 缺少合法的 id')
    if (!isObj(at.meta) || at.meta.id !== at.id) throw new BackupError('attachment.meta.id 必须与 at.id 一致')
    if (!isStr(at.mimeType) || !/^image\//.test(at.mimeType)) throw new BackupError('attachment.mimeType 非法')
    if (!isBase64(at.data)) throw new BackupError('attachment.data 不是合法的 base64')
    attIds.add(at.id)
  }

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

  for (const c of input.conversations) {
    for (const m of c.messages) {
      for (const img of m.images) {
        if (!attIds.has(img)) throw new BackupError('message 引用了不存在的附件：' + String(img).slice(0, 8))
      }
    }
  }
  // V3/V4: validate persisted Draft user data + appearance (referenced attachments must exist).
  if (isV3 || isV4) {
    const app = (input as BackupV3).appearance
    if (!VALID_APPEARANCE.has(app)) throw new BackupError('appearance 必须是 system / light / dark')
    const drafts = (input as BackupV3).drafts
    if (!Array.isArray(drafts)) throw new BackupError('缺少 drafts 数组')
    const draftIds = new Set<string>()
    for (const d of drafts) {
      if (!isObj(d)) throw new BackupError('draft 对象非法')
      if (!isNonEmptyStr(d.conversationId)) throw new BackupError('draft.conversationId 非法')
      if (draftIds.has(d.conversationId)) throw new BackupError('draft conversationId 重复：' + d.conversationId.slice(0, 8))
      draftIds.add(d.conversationId)
      if (!convIds.has(d.conversationId)) throw new BackupError('draft 引用了不存在的会话：' + d.conversationId.slice(0, 8))
      if (!isStr(d.text)) throw new BackupError('draft.text 必须是字符串')
      if (!Array.isArray(d.imageIds) || !d.imageIds.every(isStr)) throw new BackupError('draft.imageIds 必须是字符串数组')
      for (const img of d.imageIds) {
        if (!attIds.has(img)) throw new BackupError('draft 引用了不存在的附件：' + String(img).slice(0, 8))
      }
    }
  }

  if (isV4) validateV4BranchesAndArtifacts(input as BackupV4, input.conversations, input.attachments)
  validateDocuments(input)
  return input as Backup
}


function validateV4BranchesAndArtifacts(input: BackupV4, conversations: any[], attachments: any[]): void {
  if (!Array.isArray(input.branches)) throw new BackupError('缺少 branches 数组')
  if (!Array.isArray(input.branchDrafts)) throw new BackupError('缺少 branchDrafts 数组')
  if (!Array.isArray(input.artifacts)) throw new BackupError('缺少 artifacts 数组')
  if (!Array.isArray(input.activeBranches)) throw new BackupError('缺少 activeBranches 数组')
  const attIds = new Set<string>(); for (const at of attachments) attIds.add(at.id)
  const convById = new Map<string, any>(); for (const c of conversations) convById.set(c.id, c)

  const branchIds = new Set<string>()
  const branchesByConv = new Map<string, ConversationBranch[]>()
  for (const b of input.branches) {
    if (!isObj(b) || !isNonEmptyStr(b.id)) throw new BackupError('branch 缺少合法的 id')
    if (branchIds.has(b.id)) throw new BackupError('branch id 重复：' + String(b.id).slice(0, 8))
    branchIds.add(b.id)
    if (!isNonEmptyStr(b.conversationId)) throw new BackupError('branch.conversationId 非法')
    if (!convById.has(b.conversationId)) throw new BackupError('branch 引用了不存在的会话：' + String(b.conversationId).slice(0, 8))
    if (!isStr(b.title)) throw new BackupError('branch.title 非法')
    if (!isNum(b.createdAt) || !isNum(b.updatedAt)) throw new BackupError('branch 时间戳非法')
    if (!isNonEmptyStr(b.forkMessageId)) throw new BackupError('branch.forkMessageId 非法')
    if (b.parentBranchId !== undefined && !isNonEmptyStr(b.parentBranchId)) throw new BackupError('branch.parentBranchId 非法')
    if (!Array.isArray(b.messages)) throw new BackupError('branch.messages 必须是数组')
    const locals = new Set<string>()
    for (const m of b.messages) {
      if (!isObj(m) || !isNonEmptyStr(m.id)) throw new BackupError('branch message 缺少合法的 id')
      if (!VALID_ROLES.has(m.role)) throw new BackupError('branch message.role 非法')
      if (!isStr(m.content)) throw new BackupError('branch message.content 非法')
      if (!Array.isArray(m.images) || !m.images.every(isStr)) throw new BackupError('branch message.images 非法')
      if (!isNum(m.createdAt) || !isNum(m.updatedAt)) throw new BackupError('branch message 时间戳非法')
      if (locals.has(m.id)) throw new BackupError('branch message.id 重复')
      locals.add(m.id)
      for (const img of m.images) if (!attIds.has(img)) throw new BackupError('branch message 引用了不存在的附件：' + String(img).slice(0, 8))
    }
    const arr = branchesByConv.get(b.conversationId) ?? []
    arr.push(b as ConversationBranch)
    branchesByConv.set(b.conversationId, arr)
  }

  // Never restore a corrupt branch graph: validate integrity per conversation.
  for (const [convId, convBranches] of branchesByConv) {
    const conv = convById.get(convId)
    const diags = validateBranchGraph(conv, convBranches)
    if (diags.length > 0) throw new BackupError('分支图不完整：' + diags[0].code + '（分支 ' + String(convBranches[0]?.id ?? '').slice(0, 8) + '）')
  }

  const draftBranchIds = new Set<string>()
  for (const d of input.branchDrafts) {
    if (!isObj(d) || !isNonEmptyStr(d.branchId)) throw new BackupError('branchDraft.branchId 非法')
    if (!branchIds.has(d.branchId)) throw new BackupError('branchDraft 引用了不存在的分支')
    if (draftBranchIds.has(d.branchId)) throw new BackupError('branchDraft branchId 重复')
    draftBranchIds.add(d.branchId)
    if (!isStr(d.text)) throw new BackupError('branchDraft.text 必须是字符串')
    if (!Array.isArray(d.imageIds) || !d.imageIds.every(isStr)) throw new BackupError('branchDraft.imageIds 非法')
    for (const img of d.imageIds) if (!attIds.has(img)) throw new BackupError('branchDraft 引用了不存在的附件：' + String(img).slice(0, 8))
  }

  // Artifacts are self-contained via their frozen snapshot; they may reference a deleted source.
  const artifactIds = new Set<string>()
  for (const a of input.artifacts) {
    if (!isObj(a) || !isNonEmptyStr(a.id)) throw new BackupError('artifact 缺少合法的 id')
    if (artifactIds.has(a.id)) throw new BackupError('artifact id 重复')
    artifactIds.add(a.id)
    const va = validateArtifact(a)
    if (!va) throw new BackupError('artifact 形状不合法')
    // Only a PRESENT quiz payload must be structurally valid. A non-ready quiz (draft /
    // generating / error) may carry no quiz yet — validateArtifact already rejects a ready
    // quiz missing its payload, so guard against undefined here to avoid a hard import crash.
    if (va.kind === 'quiz' && va.quiz !== undefined) { try { validateQuizDocument(va.quiz) } catch { throw new BackupError('artifact quiz 结构不合法') } }
  }

  for (const ab of input.activeBranches) {
    if (!isObj(ab) || !isNonEmptyStr(ab.conversationId) || !isNonEmptyStr(ab.branchId)) throw new BackupError('activeBranch 非法')
    const convBranches = branchesByConv.get(ab.conversationId)
    if (!convBranches || !convBranches.some((b) => b.id === ab.branchId)) throw new BackupError('activeBranch 引用了不存在的分支')
  }
}

function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime || 'application/octet-stream' })
}

// After an import there is NO live generation ownership. A backup taken mid-generation would
// otherwise resurrect as a permanent "正在生成……" spinner with nothing driving it. Map any
// generating artifact to a recoverable error, preserving any existing content / quiz / raw output.
function restoreArtifacts(artifacts: StudyArtifact[]): StudyArtifact[] {
  return artifacts.map((a) => {
    if (a.status !== 'generating') return a
    return {
      ...a,
      status: 'error',
      error: '备份时该学习成果仍在生成，恢复后需要重新生成。',
      ...(a.generatedContent !== undefined ? { generatedContent: a.generatedContent } : {}),
    }
  })
}

// Staged restore (Stage 9.4D): decodes + stages new binary objects, commits metadata in ONE
// idbReplaceAll transaction, then cleans up old OPFS refs best-effort. A failure at ANY step
// leaves the existing data intact (staged OPFS files deleted, old IDB untouched).
export async function restoreBackup(backup: Backup): Promise<void> {
  const v2 = 'documents' in backup ? (backup as BackupV2) : null;
  const staged: { ref: StoredBinary; path: string | null }[] = [];
  const oldRefs: StoredBinary[] = [];
  try {
    // A. Decode + stage each attachment binary to a UNIQUE new path (never overwrite).
    const attachRows: any[] = [];
    for (const at of backup.attachments) {
      const blob = base64ToBlob(at.data, at.mimeType || at.meta.mimeType);
      const ref = await persistBinary('attachments', at.id, blob, { mimeType: at.mimeType || at.meta.mimeType });
      if (ref.storage === 'opfs') staged.push({ ref, path: ref.path });
      attachRows.push({ id: at.id, meta: at.meta as Attachment, binary: ref, recordVersion: 2 });
    }
    // B. Stage each document binary (metadata preserved; sourceBlob dropped from meta).
    const documentsArray = v2 ? v2.documents : [];
    const documentRows: any[] = [];
    for (const d of documentsArray) {
      const blob = base64ToBlob(d.data, d.mimeType);
      const ref = await persistBinary('documents', d.id, blob, { mimeType: d.mimeType });
      if (ref.storage === 'opfs') staged.push({ ref, path: ref.path });
      // recordVersion 3 + lastReadAt backfill (old backups lack the field).
      const lastReadAt = (typeof d.meta.lastReadAt === 'number') ? d.meta.lastReadAt : (typeof d.meta.updatedAt === 'number' ? d.meta.updatedAt : (typeof d.meta.createdAt === 'number' ? d.meta.createdAt : 0));
      documentRows.push({ ...d.meta, lastReadAt, source: ref, recordVersion: 3 });
    }
    // C. Build replacement metadata records pointing at the NEW binary refs.
    const settings = [
      { key: 'apiBaseUrl', value: backup.settings?.apiBaseUrl || 'https://api.deepseek.com' },
      { key: 'model', value: backup.settings?.model || 'deepseek-chat' },
      { key: 'customSystemPrompt', value: backup.settings?.customSystemPrompt || '' },
      { key: 'customSystemPromptEnabled', value: backup.settings?.customSystemPromptEnabled ? 'true' : 'false' },
      { key: 'apiKey', value: '' },
      // v1.1.3: restore saved reusable custom actions (settings KV). Missing field in an old
      // backup -> empty (no custom actions), never an error.
      { key: 'customArtifactActions', value: (backup.settings as { customArtifactActions?: unknown } | undefined)?.customArtifactActions || [] },
      // V3: restore the appearance + every persisted Draft row (unsent user data). The API
      // Key is NEVER restored (always empty). Draft rows re-create the unsent composer state.
      { key: 'appearance', value: (backup as BackupV3).appearance || 'system' },
      ...((backup as BackupV3).drafts || []).map((d: BackupDraft) => ({ key: 'draft:' + d.conversationId, value: { version: 1, text: d.text, imageIds: d.imageIds } })),
      ...((backup as BackupV4).branchDrafts || []).map((d: BackupBranchDraft) => ({ key: 'draft-branch:' + d.branchId, value: { version: 1, text: d.text, imageIds: d.imageIds } })),
      ...((backup as BackupV4).activeBranches || []).map((ab: BackupActiveBranch) => ({ key: 'activeBranch:' + ab.conversationId, value: ab.branchId })),
    ];
    // D. Snapshot OLD opfs refs for post-success cleanup.
    const oldDocs = await oldDocumentRefs();
    const oldAtts = await oldAttachmentRefs();
    oldRefs.push(...oldDocs, ...oldAtts);
    // E. One atomic IDB replacement.
    await idbReplaceAll({ settings, conversations: backup.conversations, attachments: attachRows, annotations: backup.annotations as Annotation[], documents: documentRows, conversationBranches: (backup as BackupV4).branches || [], artifacts: restoreArtifacts((backup as BackupV4).artifacts || []) });
  } catch (e) {
    // Rollback: delete every staged OPFS file. Old IDB is untouched.
    for (const s of staged) { if (s.path) { try { await deleteBinary(s.ref) } catch { /* orphan */ } } }
    throw e;
  }
  // F. Post-success cleanup of old OPFS refs (best-effort; only orphans, never new data).
  for (const old of oldRefs) { if (old.storage === 'opfs') { try { await deleteBinary(old) } catch { /* orphan */ } } }
}

async function oldDocumentRefs(): Promise<StoredBinary[]> {
  const rows = await idbGetAll('documents');
  return (rows as any[]).filter((r: any) => r?.source?.storage === 'opfs').map((r: any) => r.source);
}
async function oldAttachmentRefs(): Promise<StoredBinary[]> {
  const rows = await idbGetAll('attachments');
  return (rows as any[]).filter((r: any) => r?.binary?.storage === 'opfs').map((r: any) => r.binary);
}