import { useSyncExternalStore } from 'react'
import { type Conversation, type Message, type Attachment, type StableId, newStableId, NEW_TITLE } from './types'
import { sanitizeTitle } from './session-title'
import { getSetting, setSetting, saveConversation, deleteConversation, listConversations } from '../storage/storage'
import { getSettingsSnapshot } from './settings-store'
import { streamTextChat, DeepSeekError, errorKindLabel, buildApiMessages, buildContextMessages, buildRequestMessages, countImageParts, isVisionModel, exceedsVisionImageCount } from '../api/deepseek'
import { toDataUrl, deleteAttachment, attachmentErrorLabel, AttachmentError, sumAttachmentBytes, isInlineImageOverBudget } from './attachment-service'
import { deleteConvAnnotations } from '../annotations/annotation-service'
import { getDraft, deleteDraft, initDrafts } from './draft-store'

export type { Conversation as ChatSession, Message as ChatMsg, Attachment as ChatImage }
export const uid = (_p?: string) => newStableId()
/** Ink-screen-friendly UI render throttle (reserved for a future settings field). */
export const streamRenderIntervalMs = 200
export type RequestStatus = 'idle' | 'sending' | 'streaming' | 'error'
export function makeSession(title: string = NEW_TITLE): Conversation {
  const now = Date.now()
  return { id: newStableId(), title, createdAt: now, updatedAt: now, messages: [] }
}

export type SessionsState = {
  list: Conversation[]; byId: Record<string, Conversation>; current: string | undefined; ready: boolean
  status: RequestStatus; sendError: string | undefined
}

let state: SessionsState = { list: [], byId: {}, current: undefined, ready: false, status: 'idle', sendError: undefined }
const subs = new Set<() => void>()
function setState(next: SessionsState) { state = next; subs.forEach(f => f()) }
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
const getSnapshot = () => state
export function useSessions<T>(sel: (s: SessionsState) => T): T { return useSyncExternalStore(subscribe, () => sel(state)) }
export function getSessionsStatus(): RequestStatus { return state.status }
export function getSessionsSendError(): string | undefined { return state.sendError }
export function getSessionsCurrent(): string | undefined { return state.current }

function index(list: Conversation[]): Record<string, Conversation> {
  const m: Record<string, Conversation> = {}; for (const c of list) m[c.id] = c; return m
}
function sortList(list: Conversation[]): Conversation[] { return [...list].sort((a, b) => b.updatedAt - a.updatedAt) }
function toState(list: Conversation[], current?: string, ready = state.ready, status = state.status, sendError = state.sendError): SessionsState {
  const sorted = sortList(list)
  return { list: sorted, byId: index(sorted), current: current ?? sorted[0]?.id, ready, status, sendError }
}
function upsertState(conv: Conversation, extra?: Partial<SessionsState>) {
  setState({ ...toState(state.list.map(c => c.id === conv.id ? conv : c), state.current), ...(extra || {}) })
}
const LAST_CONV = 'lastConversationId'
let abortControllerRef: AbortController | null = null


export const sessionsActions = {
  async newChat(): Promise<string> {
    const c = makeSession()
    setState(toState([c, ...state.list], c.id))
    await saveConversation(c); await setSetting(LAST_CONV, c.id)
    return c.id
  },
  async open(id: string) {
    if (state.status === 'sending' || state.status === 'streaming') return // freeze: don't switch while generating
    setState(toState(state.list, id, state.ready, state.status, state.sendError))
    await setSetting(LAST_CONV, id)
  },
  stopGenerating() { if (abortControllerRef) abortControllerRef.abort() },
  /**
   * Send a user message. Returns true when the user message (+ its image ids) has
   * been ACCEPTED and persisted into the conversation; false when the send was
   * rejected before acceptance (busy / no conversation / empty). The Compose caller
   * should only clear its draft / transfer attachment ownership when this returns true.
   */
  async sendUserMessage(id: string, content: string, imageIds: StableId[] = []): Promise<boolean> {
    if (state.status === 'sending' || state.status === 'streaming') return false
    const conv = state.byId[id]; if (!conv) return false
    if (!content.trim() && imageIds.length === 0) return false
    const now = Date.now()
    const m: Message = { id: newStableId(), role: 'user', content, images: imageIds, createdAt: now, updatedAt: now }
    const titled = conv.title === NEW_TITLE && content ? content.slice(0, 18) : conv.title
    const afterUser: Conversation = { ...conv, title: titled, updatedAt: now, messages: [...conv.messages, m] }
    upsertState(afterUser, { status: 'sending', sendError: undefined })
    await saveConversation(afterUser); await setSetting(LAST_CONV, id)
    // Accepted: the user message + its image ids are now persisted in the conversation.
    // Run the reply stream in the BACKGROUND so the caller can clear its draft and
    // transfer attachment ownership immediately, without blocking on the network.
    void runReplyStream(id, afterUser)
    return true
  },
  async addAssistant(id: string, content: string) {
    const conv = state.byId[id]; if (!conv) return
    const now = Date.now()
    const m: Message = { id: newStableId(), role: 'assistant', content, images: [], createdAt: now, updatedAt: now }
    const updated: Conversation = { ...conv, updatedAt: now, messages: [...conv.messages, m] }
    upsertState(updated); await saveConversation(updated)
  },
  async setTitle(id: string, title: string) {
    const conv = state.byId[id]; if (!conv) return
    const clean = sanitizeTitle(title)
    // Never store an empty / whitespace-only title; a no-op rename just returns.
    if (!clean) return
    const updated: Conversation = { ...conv, title: clean, updatedAt: Date.now() }
    upsertState(updated); await saveConversation(updated)
  },
  async remove(id: string) {
    const conv = state.byId[id]
    const next = toState(state.list.filter(c => c.id !== id), state.current === id ? undefined : state.current)
    setState(next)
    await deleteConversation(id)
    if (conv) {
      const ids = new Set<string>()
      for (const m of conv.messages) for (const img of m.images) ids.add(img)
      for (const img of ids) { try { await deleteAttachment(img) } catch {} }
      try { await deleteConvAnnotations(id) } catch {}
    }
    // Pending draft attachments (never sent) belong only to THIS conversation's draft.
    // Delete only those not already referenced by a message; never touch B's data.
    const referenced = new Set<string>()
    if (conv) for (const m of conv.messages) for (const img of m.images) referenced.add(img)
    const draft = getDraft(id)
    for (const img of draft.imageIds) { if (!referenced.has(img)) { try { await deleteAttachment(img) } catch {} } }
    await deleteDraft(id)
    // Persist the REAL current session (not the top-of-list one) so reloads reopen it.
    await setSetting(LAST_CONV, next.current ?? '')
  },
}

/** Fire-and-forget reply stream: runs AFTER the user message is accepted & persisted. */
async function runReplyStream(id: string, afterUser: Conversation): Promise<void> {
  const settings = getSettingsSnapshot()
  if (!settings.apiKey) { setState({ ...state, status: 'error', sendError: errorKindLabel('no-api-key') }); return }
  const now = Date.now()
  const assistantId = newStableId()
  const controller = new AbortController()
  let received = ''
  let lastCommit = 0
  const commit = () => {
    const cur = state.byId[id]; if (!cur) return
    const last = cur.messages[cur.messages.length - 1]
    if (!last || last.id !== assistantId) return
    if (last.content === received) return
    const updatedMsg: Message = { ...last, content: received, updatedAt: Date.now() }
    const updated: Conversation = { ...cur, updatedAt: Date.now(), messages: [...cur.messages.slice(0, -1), updatedMsg] }
    upsertState(updated, { status: 'streaming', sendError: undefined })
  }
  const onDelta = (d: string) => { received += d; const t = Date.now(); if (t - lastCommit >= streamRenderIntervalMs) { lastCommit = t; commit() } }
  try {
    // --- LOCAL PREFLIGHT (no network, and NO assistant placeholder yet) ---
    // A preflight failure must not leave a ghost empty assistant message behind.
    // Image-context policy (§17): text history is always retained, but only the most
    // recent N image-bearing turns keep their images, so a growing conversation never
    // re-encodes the whole historical image set on every request.
    const contextMessages = buildContextMessages(afterUser.messages)
    const hasImages = contextMessages.some(x => x.images.length > 0)
    if (hasImages && !isVisionModel(settings.model)) { setState({ ...state, status: 'error', sendError: attachmentErrorLabel('vision-unsupported') }); return }
    // Inline-base64 payload guard: refuse to base64-encode + POST a request whose
    // retained raw image bytes would blow past the request-size budget. Uses only
    // recorded blob sizes (attachment meta.size) — no encoding, no network.
    const retainedImageIds = contextMessages.flatMap(x => x.images)
    if (retainedImageIds.length > 0) {
      const totalImageBytes = await sumAttachmentBytes(retainedImageIds)
      if (isInlineImageOverBudget(totalImageBytes)) {
        setState({ ...state, status: 'error', sendError: '当前消息包含的图片数据过多，可能超过模型接口的请求大小限制。请减少本次选择的 PDF 页数或图片数量。' })
        return
      }
      // DeepSeek vision API image-count limit (600) — based on the FINAL retained set,
      // not the current PDF alone, since history images also occupy slots.
      const retainedImages = contextMessages.reduce((sum, mm) => sum + mm.images.length, 0)
      if (exceedsVisionImageCount(retainedImages)) {
        setState({ ...state, status: 'error', sendError: '当前对话需要发送的图片数量过多。请减少本次 PDF 页面或图片后重试。' })
        return
      }
    }
    const apiMessages = await buildApiMessages(contextMessages, toDataUrl)
    const reqMessages = buildRequestMessages(apiMessages, settings)
    // Invariant (§16): the outgoing request must encode exactly the images the context
    // policy retained. If not, block the fetch and tell the user — never silently drop.
    const expectedImages = contextMessages.reduce((sum, mm) => sum + mm.images.length, 0)
    const encodedImages = countImageParts(reqMessages)
    if (encodedImages !== expectedImages) {
      setState({ ...state, status: 'error', sendError: '图片准备失败：已选择 ' + expectedImages + ' 张，实际仅准备成功 ' + encodedImages + ' 张。请检查附件后重试。' })
      return
    }

    // --- only NOW create the assistant placeholder (ONE stable id for the whole stream) ---
    const placeholder: Message = { id: assistantId, role: 'assistant', content: '', images: [], createdAt: now, updatedAt: now }
    const withPlaceholder: Conversation = { ...afterUser, updatedAt: now, messages: [...afterUser.messages, placeholder] }
    upsertState(withPlaceholder, { status: 'streaming', sendError: undefined })
    abortControllerRef = controller

    const r = await streamTextChat({ apiKey: settings.apiKey, baseUrl: settings.apiBaseUrl, model: settings.model, messages: reqMessages, signal: controller.signal, onDelta })
    received = r.content
    commit()
    const finalConv = state.byId[id]
    if (finalConv) await saveConversation(finalConv)
    setState({ ...state, status: 'idle', sendError: undefined })
    abortControllerRef = null
  } catch (e) {
    commit()
    const cur = state.byId[id]
    if (cur) await saveConversation(cur)
    // Attachment errors keep their own semantics — a missing/corrupt image should
    // read as an attachment problem, never as a network/CORS failure.
    if (e instanceof AttachmentError) { setState({ ...state, status: 'error', sendError: attachmentErrorLabel(e.kind) }); abortControllerRef = null; return }
    const err = e instanceof DeepSeekError ? e : new DeepSeekError('network-or-cors', String(e))
    if (err.kind === 'aborted') { setState({ ...state, status: 'idle', sendError: undefined }) }
    else { const label = errorKindLabel(err.kind) + (err.status ? ('（HTTP ' + err.status + '）') : ''); setState({ ...state, status: 'error', sendError: label }) }
    abortControllerRef = null
  }
}

export async function initStore(): Promise<void> {
  const convs = await listConversations()
  if (convs.length === 0) {
    // First run: create ONE empty conversation (no demo/seed content) so the
    // composer has a current session; the UI shows the product empty state.
    const c = makeSession()
    await saveConversation(c)
    await setSetting(LAST_CONV, c.id)
    await initDrafts([c.id])
    setState(toState([c], c.id, true))
    return
  }
  const last = await getSetting(LAST_CONV)
  const lastOk = last && convs.some(c => c.id === last) ? last : convs[0].id
  await initDrafts(convs.map(c => c.id))
  setState(toState(convs, lastOk, true))
  await setSetting(LAST_CONV, lastOk)
}