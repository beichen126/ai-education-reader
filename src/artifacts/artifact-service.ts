import { newStableId, type Message, type StableId } from '../engine/types'
import { getConversation } from '../storage/storage'
import { getAttachment } from '../engine/attachment-service'
import { buildEffectivePathThrough, resolveBranchLineage } from '../branches/branch-path'
import { listBranchesByConversation } from '../branches/branch-store'
import { getArtifact, saveArtifact, deleteArtifact } from './artifact-store'
import { validateArtifact } from './artifact-validation'
import type { ArtifactKind, ArtifactSource, ArtifactSourceSnapshot, SourceCitation, StudyArtifact } from './artifact-types'

export class ArtifactError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ArtifactError' } }

/**
 * Freeze an immutable source snapshot at the selected point. Only role/text + image refs
 * and REAL attachment provenance metadata are captured — never binaries, never later messages.
 */
export async function buildSourceSnapshot(
  conversationId: StableId,
  branchId: StableId | undefined,
  throughMessageId: StableId,
): Promise<ArtifactSourceSnapshot> {
  const conversation = await getConversation(conversationId)
  if (!conversation) throw new ArtifactError('source-conversation-missing', '原始会话不存在')
  const branches = await listBranchesByConversation(conversationId)
  const eff = buildEffectivePathThrough(conversation, branches, { branchId }, throughMessageId)
  if (eff.length === 0) throw new ArtifactError('source-point-missing', '未在所选分支中找到该截止消息')
  const messages: ArtifactSourceSnapshot['messages'] = eff.map((m) => ({ role: m.role, text: m.content, imageIds: m.images }))
  const provenance: SourceCitation[] = []
  for (const m of eff) {
    for (const imgId of m.images) {
      const att = await getAttachment(imgId)
      if (!att) continue
      if (att.source && att.source.type === 'pdf-page') {
        provenance.push({
          origin: 'pdf-page',
          fileName: att.source.fileName,
          documentId: att.source.documentId,
          pageNumber: att.source.pageNumber,
          ...(typeof att.source.selection?.title === 'string' ? { title: att.source.selection.title } : {}),
        })
      } else {
        provenance.push({ origin: 'image', fileName: att.name })
      }
    }
  }
  const sourceLabel = buildSourceLabel(provenance, branchId)
  return { conversationId, branchId, throughMessageId, createdAt: Date.now(), messages, provenance, sourceLabel, sourceDeleted: false }
}

function buildSourceLabel(provenance: SourceCitation[], branchId: StableId | undefined): string {
  const base = branchId ? '分支 ' : '会话'
  if (provenance.length === 0) return base
  // Show the most specific (PDF page) citation if present.
  const pdf = provenance.find((p) => p.origin === 'pdf-page')
  if (pdf) {
    const file = pdf.fileName ?? 'PDF'
    const page = pdf.pageNumber !== undefined ? (' p.' + pdf.pageNumber) : ''
    return file + page
  }
  return provenance[0].fileName ?? base
}

/**
 * Materialize the FROZEN source messages for generation (role/text/image refs). Uses the
 * snapshot captured at generation start — never drifts to later messages even if the
 * user keeps chatting while generation runs.
 */
export function materializeSourceMessages(source: ArtifactSource): Message[] {
  return source.snapshot.messages.map((m) => ({
    id: source.snapshot.throughMessageId + ':snap:' + m.role + ':' + m.text.length + ':' + m.imageIds.join('-'),
    role: m.role,
    content: m.text,
    images: m.imageIds,
    createdAt: source.snapshot.createdAt,
    updatedAt: source.snapshot.createdAt,
  }))
}

/** Whether the artifact's live source conversation + branch still resolve (for '原会话已删除'). */
export async function isArtifactSourceLive(artifact: StudyArtifact): Promise<boolean> {
  const conv = await getConversation(artifact.source.conversationId)
  if (!conv) return false
  if (artifact.source.branchId) {
    const branches = await listBranchesByConversation(artifact.source.conversationId)
    if (!branches.some((b) => b.id === artifact.source.branchId)) return false
  }
  return true
}

const KIND_TITLE: Record<ArtifactKind, string> = { note: '笔记', quiz: '题目', summary: '总结', 'study-guide': '学习指南', custom: '自定义结果' }
function defaultTitle(kind: ArtifactKind): string { return KIND_TITLE[kind] }

/**
 * Create the artifact draft record. The source snapshot is FROZEN here (before any model
 * call), so a generation that starts at Branch B / M12 never later includes M13/M14.
 */
export async function createArtifactDraft(input: {
  kind: ArtifactKind
  title?: string
  conversationId: StableId
  branchId?: StableId
  throughMessageId: StableId
  prompt: string
  presetId?: string
}): Promise<StudyArtifact> {
  if (!input.prompt || !input.prompt.trim()) throw new ArtifactError('prompt-empty', '提示词不能为空')
  const snapshot = await buildSourceSnapshot(input.conversationId, input.branchId, input.throughMessageId)
  const now = Date.now()
  const artifact: StudyArtifact = {
    id: newStableId(),
    kind: input.kind,
    title: (input.title && input.title.trim()) || defaultTitle(input.kind),
    source: { conversationId: input.conversationId, branchId: input.branchId, throughMessageId: input.throughMessageId, snapshot },
    presetId: input.presetId,
    prompt: input.prompt,
    createdAt: now,
    updatedAt: now,
    // A NEW artifact starts as a DRAFT. It must NOT be 'generating' until it actually
    // holds the global generation lock (see markArtifactGenerating). This is the core
    // invariant: no artifact is ever 'generating' without owning generation, so a busy/
    // failed attempt can never leave a zombie 'generating' record behind.
    status: 'draft',
  }
  await saveArtifact(artifact)
  return artifact
}

/**
 * Finalize a generation as 'ready'. `expectUpdatedAt` guards against a stale/late write
 * overwriting a newer revision (the ordered-persistence rule applied to artifacts): if the
 * stored record no longer matches the generation-time revision, the write is dropped.
 */
export async function markArtifactReady(id: StableId, payload: { content?: string; quiz?: StudyArtifact['quiz']; generatedText: string }, expectUpdatedAt?: number): Promise<StudyArtifact | undefined> {
  const a = await getArtifact(id)
  if (!a) return undefined
  if (expectUpdatedAt !== undefined && a.updatedAt !== expectUpdatedAt) return undefined
  const updated: StudyArtifact = { ...a, status: 'ready', content: payload.content, quiz: payload.quiz, generatedContent: payload.generatedText, updatedAt: Date.now() }
  await saveArtifact(updated)
  return updated
}

/**
 * Claim generation ownership on an artifact. Only called AFTER the global generation
 * lock has been acquired, so an artifact can never be 'generating' without really
 * owning generation. Returns the updated record, or undefined when the artifact is gone
 * or was edited/deleted since `expectUpdatedAt` (a stale claim must not proceed).
 */
export async function markArtifactGenerating(id: StableId, expectUpdatedAt?: number): Promise<StudyArtifact | undefined> {
  const a = await getArtifact(id)
  if (!a) return undefined
  if (expectUpdatedAt !== undefined && a.updatedAt !== expectUpdatedAt) return undefined
  const updated: StudyArtifact = { ...a, status: 'generating', updatedAt: Date.now() }
  await saveArtifact(updated)
  return updated
}

/**
 * Mark an artifact as error. `generatedContent` may be provided to keep the RAW model
 * output so a failed quiz is never silently lost (the user can inspect what the model
 * actually produced). When `generatedContent` is supplied it is preserved even though
 * the artifact is in error state.
 */
export async function markArtifactError(id: StableId, message: string, payload?: { generatedContent?: string }): Promise<StudyArtifact | undefined> {
  const a = await getArtifact(id)
  if (!a) return undefined
  const updated: StudyArtifact = { ...a, status: 'error', error: message, ...(payload?.generatedContent !== undefined ? { generatedContent: payload.generatedContent } : {}), updatedAt: Date.now() }
  await saveArtifact(updated)
  return updated
}

/** Persist a user edit. `generatedContent` stays as the original model result. */
export async function updateArtifactContent(id: StableId, content: string): Promise<StudyArtifact | undefined> {
  const a = await getArtifact(id)
  if (!a) return undefined
  const updated: StudyArtifact = { ...a, content, updatedAt: Date.now() }
  await saveArtifact(updated)
  return updated
}

export async function updateArtifactTitle(id: StableId, title: string): Promise<StudyArtifact | undefined> {
  const a = await getArtifact(id)
  if (!a) return undefined
  const clean = title.trim() || defaultTitle(a.kind)
  const updated: StudyArtifact = { ...a, title: clean, updatedAt: Date.now() }
  await saveArtifact(updated)
  return updated
}

export async function removeArtifact(id: StableId): Promise<void> { await deleteArtifact(id) }

/** Validate a record before it is trusted (used by the backup importer + boot). */
export function assertValidArtifact(artifact: unknown): StudyArtifact {
  const a = validateArtifact(artifact)
  if (!a) throw new ArtifactError('invalid-artifact', '图形记录不合法')
  return a
}