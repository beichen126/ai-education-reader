import { useSyncExternalStore } from 'react'
import { type Conversation, type Message, type Attachment, type StableId, newStableId, NEW_TITLE } from './types'
import { sanitizeTitle } from './session-title'
import { getSetting, setSetting, saveConversation, deleteConversation, listConversations, commitAcceptedUserMessage } from '../storage/storage'
import { getSettingsSnapshot } from './settings-store'
import { streamTextChat, DeepSeekError, errorKindLabel, buildApiMessages, buildContextMessages, buildRequestMessages, countImageParts, isVisionModel, exceedsVisionImageCount } from '../api/deepseek'
import { toDataUrl, deleteAttachment, attachmentErrorLabel, AttachmentError, sumAttachmentBytes, isInlineImageOverBudget } from './attachment-service'
import { deleteConvAnnotations } from '../annotations/annotation-service'
import { getDraft, deleteDraft, initDrafts, draftSettingKey, clearDraftMemory } from './draft-store'
import { runThreadReply, type ReplyThread } from './stream-reply'

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
/** Id of a conversation whose user-message acceptance transaction is in flight. */
const acceptingRef = { current: null as string | null }

/** An explicitly-tracked active reply generation. Prevents the accidental mixture of
 *  'a naked global AbortController' + a stale snapshot. One generation globally.
 *  `controller` is the AbortController; a deletion/switch aborts it; a NEW generation
 *  replaces it (aborting the previous). */
type ActiveGeneration = { conversationId: string; assistantId: string; controller: AbortController }
let activeGeneration: ActiveGeneration | null = null

/** Per-conversation serialized durable-write queue. Every persistence of a conversation's
 *  streaming assistant content is chained AFTER the previous durable write, so a stale
 *  partial checkpoint can NEVER overwrite a newer durable revision (P0-2 monotonic writes).
 *  The map entry is cleared once the chain drains. */
const writeChains = new Map<string, Promise<void>>()
/** Exported for deterministic regression tests (P0-2 ordering). */
export function enqueueWrite(convId: string, write: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(convId) || Promise.resolve()
  const next = prev.then(() => write()).catch((e) => { console.error('[stream] durable write failed', convId, e) })
  writeChains.set(convId, next)
  return next
}
/** Resolve when all queued durable writes for a conversation have settled (used to await the
 *  full queue before returning/clearing ownership on completion/abort/error). */
function drainWrites(convId: string): Promise<void> { return writeChains.get(convId) || Promise.resolve() }


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
    // Double-submit guard while the acceptance transaction is in progress.
    if (acceptingRef.current === id) return false
    const conv = state.byId[id]; if (!conv) return false
    if (!content.trim() && imageIds.length === 0) return false
    const now = Date.now()
    const m: Message = { id: newStableId(), role: 'user', content, images: imageIds, createdAt: now, updatedAt: now }
    const titled = conv.title === NEW_TITLE && content ? content.slice(0, 18) : conv.title
    const afterUser: Conversation = { ...conv, title: titled, updatedAt: now, messages: [...conv.messages, m] }
    // Optimistically show 'sending' and block concurrent sends; revert on failure.
    upsertState(afterUser, { status: 'sending', sendError: undefined })
    acceptingRef.current = id
    try {
      // ONE durable transaction: put conversation + put lastConversationId + delete the
      // draft row. The user message is ACCEPTED only if this transaction commits. On
      // failure nothing commits, the Draft stays intact and no reply stream starts.
      const draftKey = draftSettingKey(id)
      await commitAcceptedUserMessage(afterUser, id, draftKey)
    } catch (e) {
      // Revert the optimistic memory state; Draft memory + durable Draft remain intact.
      upsertState(conv, { status: state.status === 'error' ? 'error' : 'idle', sendError: '消息发送失败，请重试。' })
      acceptingRef.current = null
      return false
    }
    acceptingRef.current = null
    // Accepted: the user message + its image ids are now durably in the conversation AND
    // the draft row was deleted in the same commit. Clear Draft MEMORY without issuing
    // another required database mutation (no duplicate write).
    clearDraftMemory(id)
    // Run the reply stream in the BACKGROUND so the caller can transfer attachment
    // ownership immediately, without blocking on the network.
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
    // If a reply stream is actively generating for THIS conversation, abort it. It must
    // never resurrect a deleted conversation or recreate deleted attachments/messages.
    if (activeGeneration && activeGeneration.conversationId === id) { activeGeneration.controller.abort(); activeGeneration = null; abortControllerRef = null }
    // Invalidate any pending durable write for this conversation so a late checkpoint cannot
    // recreate the deleted row (P0-2).
    writeChains.delete(id)
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

/** Durable save routed through the per-conversation serialized write queue (P0-2). Each
 *  checkpoint/final write is chained AFTER the previous durable write so a stale partial can
 *  never overwrite a newer revision. Never throws (a failed write must not corrupt the
 *  in-memory stream); the chain keeps the next queued write alive regardless. */
export async function persistConversation(conv: Conversation): Promise<void> {
  // Guard: never resurrect a conversation that was deleted while a write was queued.
  return enqueueWrite(conv.id, async () => { if (state.byId[conv.id]) await saveConversation(conv) })
}

/** Fire-and-forget reply stream: runs AFTER the user message is accepted & persisted. */
/**
 * Root conversation target for the shared streaming engine. The engine is thread-agnostic;
 * this target binds it to the existing root Conversation (v1 behavior preserved). */
class RootReplyThread implements ReplyThread {
  readonly genKey: string
  private assistantId: StableId = ''
  constructor(private id: string) { this.genKey = 'chat:root:' + id }
  getContextMessages(): Message[] { return state.byId[this.id]?.messages ?? [] }
  createAssistantPlaceholder(assistantId: StableId, now: number): void {
    this.assistantId = assistantId
    const cur = state.byId[this.id]; if (!cur) return
    const placeholder: Message = { id: assistantId, role: 'assistant', content: '', images: [], createdAt: now, updatedAt: now }
    upsertState({ ...cur, updatedAt: now, messages: [...cur.messages, placeholder] }, { status: 'streaming', sendError: undefined })
  }
  updateAssistantContent(content: string): void {
    const cur = state.byId[this.id]; if (!cur) return
    const last = cur.messages[cur.messages.length - 1]
    if (!last || last.id !== this.assistantId) return
    if (last.content === content) return
    const updatedMsg: Message = { ...last, content, updatedAt: Date.now() }
    upsertState({ ...cur, updatedAt: Date.now(), messages: [...cur.messages.slice(0, -1), updatedMsg] }, { status: 'streaming', sendError: undefined })
  }
  persistCheckpoint(content: string): void {
    const cur = state.byId[this.id]; if (!cur) return
    const last = cur.messages[cur.messages.length - 1]
    if (!last || last.id !== this.assistantId || last.content === content) return
    const updatedMsg: Message = { ...last, content, updatedAt: Date.now() }
    const updated: Conversation = { ...cur, updatedAt: Date.now(), messages: [...cur.messages.slice(0, -1), updatedMsg] }
    void persistConversation(updated)
  }
  async persistFinal(): Promise<void> { const cur = state.byId[this.id]; if (cur) await persistConversation(cur) }
  async drainWrites(): Promise<void> { await drainWrites(this.id) }
  exists(): boolean { return !!state.byId[this.id] }
  setStreaming(): void { setState({ ...state, status: 'streaming', sendError: undefined }) }
  setIdle(): void { setState({ ...state, status: 'idle', sendError: undefined }) }
  setError(message: string): void { setState({ ...state, status: 'error', sendError: message }) }
}

/** Fire-and-forget reply stream: runs AFTER the user message is accepted & persisted. */
async function runReplyStream(id: string, afterUser: Conversation): Promise<void> {
  const settings = getSettingsSnapshot()
  if (!settings.apiKey) { setState({ ...state, status: 'error', sendError: errorKindLabel('no-api-key') }); return }
  const controller = new AbortController()
  const thread = new RootReplyThread(id)
  await runThreadReply(thread, settings, controller, (c, assistantId) => {
    abortControllerRef = c
    activeGeneration = { conversationId: id, assistantId, controller: c }
  })
  // The engine already flushed + drained + set status; clear ownership deterministically.
  activeGeneration = null
  abortControllerRef = null
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