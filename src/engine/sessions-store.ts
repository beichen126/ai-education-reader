import { useSyncExternalStore } from 'react'
import { type Conversation, type Message, type Attachment, type StableId, type DraftDisposition, type QuickFollowUpMetadata, newStableId, NEW_TITLE } from './types'
import { sanitizeTitle } from './session-title'
import { getSetting, setSetting, getConversation, saveConversation, deleteConversation, listConversations, commitAcceptedUserMessage } from '../storage/storage'
import { getSettingsSnapshot } from './settings-store'
import { streamTextChat, DeepSeekError, errorKindLabel, buildApiMessages, buildContextMessages, buildRequestMessages, countImageParts, isVisionModel, exceedsVisionImageCount } from '../api/deepseek'
import { toDataUrl, deleteAttachment, attachmentErrorLabel, AttachmentError, sumAttachmentBytes, isInlineImageOverBudget } from './attachment-service'
import { deleteConvAnnotations } from '../annotations/annotation-service'
import { getDraft, deleteDraft, initDrafts, draftSettingKey, clearDraftMemory } from './draft-store'
import { runThreadReply, type ReplyThread } from './stream-reply'
import { generationRegistry, genRootKey, type GenerationLease } from './generation-registry'
import { attachPdfContexts } from '../pdf/pdf-message-context'
import { getBranch } from '../branches/branch-store'
import { prepareAcceptedSendContext, type AcceptedSendContext } from '../prompts/prompt-send'
import { tryWithConversationMutationLock } from '../prompts/prompt-mode-lock'
import { shouldPresentRejectedSend, validateSendInput, type RejectedSend, type SendErrorState, type SendFailure, type SendIntent, type SendOutcome, type SendTarget } from './send-outcome'

export type { Conversation as ChatSession, Message as ChatMsg, Attachment as ChatImage }
export const uid = (_p?: string) => newStableId()
/** Ink-screen-friendly UI render throttle (reserved for a future settings field). */
export const streamRenderIntervalMs = 200
export type RequestStatus = 'idle' | 'sending' | 'streaming' | 'error'
export type MessageFocusTarget = { conversationId: StableId; messageId: StableId; branchId?: StableId }
export function makeSession(title: string = NEW_TITLE): Conversation {
  const now = Date.now()
  return { id: newStableId(), title, createdAt: now, updatedAt: now, messages: [] }
}

export type SessionsState = {
  list: Conversation[]; byId: Record<string, Conversation>; current: string | undefined; ready: boolean
  status: RequestStatus; sendError: string | undefined; sendErrorTarget?: SendTarget; focusMessage?: MessageFocusTarget
}

let state: SessionsState = { list: [], byId: {}, current: undefined, ready: false, status: 'idle', sendError: undefined }
const subs = new Set<() => void>()
function setState(next: SessionsState) { state = next; subs.forEach(f => f()) }
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
// The generation registry is the single source of the global busy/stream status. A subscription
// keeps the sessions store's `state.status` in sync so the top status bar + 停止生成 button
// reflect BOTH root and branch generations. Error/idle transitions set by the stream handlers
// run AFTER this (registry.end -> idle, then setError -> error), so error state is preserved.
generationRegistry.subscribe(() => { setState({ ...state, status: generationRegistry.getStatus() }) })
const getSnapshot = () => state
export function useSessions<T>(sel: (s: SessionsState) => T): T { return useSyncExternalStore(subscribe, () => sel(state)) }
export function getSessionsStatus(): RequestStatus { return state.status }
export function getSessionsSendError(): string | undefined { return state.sendError }
export function getSessionsSendErrorTarget(): SendTarget | undefined { return state.sendErrorTarget }
export function getSessionsCurrent(): string | undefined { return state.current }
export function getSessionsFocusTarget(): MessageFocusTarget | undefined { return state.focusMessage }
export function setSessionsSendError(error: SendErrorState): void {
  setState({ ...state, status: 'error', sendError: error.message, sendErrorTarget: { conversationId: error.conversationId, ...(error.branchId ? { branchId: error.branchId } : {}) } })
}
export function clearSessionsSendError(target?: SendTarget): void {
  if (target && (!state.sendErrorTarget || state.sendErrorTarget.conversationId !== target.conversationId || state.sendErrorTarget.branchId !== target.branchId)) return
  if (!state.sendError && state.status !== 'error') return
  setState({ ...state, status: generationRegistry.getStatus(), sendError: undefined, sendErrorTarget: undefined })
}

/** Present every rejected outcome through one policy/state transition. */
export function presentRejectedSend(target: SendTarget, outcome: RejectedSend, intent: SendIntent = 'internal'): RejectedSend {
  if (shouldPresentRejectedSend(outcome, intent)) setSessionsSendError({ ...outcome, ...target })
  else clearSessionsSendError(target)
  return outcome
}

export type SendUserMessageOptions = {
  quickFollowUp?: QuickFollowUpMetadata
  draftDisposition?: DraftDisposition
}

function index(list: Conversation[]): Record<string, Conversation> {
  const m: Record<string, Conversation> = {}; for (const c of list) m[c.id] = c; return m
}
function sortList(list: Conversation[]): Conversation[] { return [...list].sort((a, b) => b.updatedAt - a.updatedAt) }
function toState(list: Conversation[], current?: string, ready = state.ready, status = state.status, sendError = state.sendError, sendErrorTarget = state.sendErrorTarget): SessionsState {
  const sorted = sortList(list)
  return { list: sorted, byId: index(sorted), current: current ?? sorted[0]?.id, ready, status, sendError, sendErrorTarget, focusMessage: state.focusMessage }
}
function upsertState(conv: Conversation, extra?: Partial<SessionsState>) {
  setState({ ...toState(state.list.map(c => c.id === conv.id ? conv : c), state.current), ...(extra || {}) })
}
const LAST_CONV = 'lastConversationId'
let abortControllerRef: AbortController | null = null
/** Id of a conversation whose user-message acceptance transaction is in flight. */
const acceptingRef = { current: null as string | null }

type PendingSend = { outcome: Promise<SendOutcome> }
type RejectedOutcome = Extract<SendOutcome, { kind: 'rejected' }>
function rejectSend(target: SendTarget, outcome: RejectedOutcome, intent: SendIntent): RejectedOutcome {
  return presentRejectedSend(target, outcome, intent)
}

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
    setState({ ...toState([c, ...state.list], c.id), focusMessage: undefined })
    await saveConversation(c); await setSetting(LAST_CONV, c.id)
    return c.id
  },
  async open(id: string) {
    if (state.status === 'sending' || state.status === 'streaming') return // freeze: don't switch while generating
    setState({ ...toState(state.list, id, state.ready, state.status, state.sendError), focusMessage: undefined })
    await setSetting(LAST_CONV, id)
  },
  /** Refresh the current in-memory row after a prompt transition was persisted by a domain service. */
  async reload(id: string): Promise<void> {
    const conversation = await getConversation(id) as Conversation | undefined
    if (conversation && state.byId[id]) upsertState(conversation)
  },
  /** Open a conversation and request a post-render scroll to one concrete message. */
  async openAtMessage(id: string, messageId: string, branchId?: string): Promise<boolean> {
    if (state.status === 'sending' || state.status === 'streaming') return false
    const conversation = state.byId[id]
    if (!conversation) { if (state.focusMessage) setState({ ...state, focusMessage: undefined }); return false }
    if (branchId) {
      const branch = await getBranch(branchId)
      if (!branch || branch.conversationId !== id || !branch.messages.some((message) => message.id === messageId)) { if (state.focusMessage) setState({ ...state, focusMessage: undefined }); return false }
    } else if (!conversation.messages.some((message) => message.id === messageId)) {
      if (state.focusMessage) setState({ ...state, focusMessage: undefined })
      return false
    }
    setState({ ...toState(state.list, id, state.ready, state.status, state.sendError), focusMessage: { conversationId: id, messageId, ...(branchId ? { branchId } : {}) } })
    await setSetting(LAST_CONV, id)
    return true
  },
  clearMessageFocus() {
    if (state.focusMessage) setState({ ...state, focusMessage: undefined })
  },
  stopGenerating() { generationRegistry.cancel() },
  /**
   * Send a user message and resolve with the terminal outcome. Acceptance still happens
   * before streaming, but the mutation lock is released before the model request runs.
   */
  async sendUserMessage(id: string, content: string, imageIds: StableId[] = [], options: SendUserMessageOptions = {}): Promise<SendOutcome> {
    const target: SendTarget = { conversationId: id }
    const intent: SendIntent = options.quickFollowUp ? 'quick-follow-up' : 'composer'
    clearSessionsSendError(target)
    if (state.status === 'sending' || state.status === 'streaming') return rejectSend(target, { kind: 'rejected', code: 'generation-busy', message: '当前已有生成任务，请稍候。' }, intent)
    const locked = await tryWithConversationMutationLock<PendingSend>(id, async () => {
      if (state.status === 'sending' || state.status === 'streaming') return { outcome: Promise.resolve(rejectSend(target, { kind: 'rejected', code: 'generation-busy', message: '当前已有生成任务，请稍候。' }, intent)) }
      if (acceptingRef.current === id) return { outcome: Promise.resolve(rejectSend(target, { kind: 'rejected', code: 'generation-busy', message: '消息正在提交，请稍候。' }, intent)) }
      const conv = state.byId[id]
      if (!conv) return { outcome: Promise.resolve(rejectSend(target, { kind: 'rejected', code: 'conversation-not-found', message: '当前会话不存在。' }, intent)) }
      const invalidInput = validateSendInput(content, imageIds, options.quickFollowUp)
      if (invalidInput) return { outcome: Promise.resolve(rejectSend(target, invalidInput, intent)) }
      const settings = getSettingsSnapshot()
      if (!settings.apiKey) return { outcome: Promise.resolve(rejectSend(target, { kind: 'rejected', code: 'no-api-key', message: '未配置 API Key，请先在设置中填写。' }, intent)) }
      const now = Date.now()
      const controller = new AbortController()
      const lease = generationRegistry.acquire(genRootKey(id), controller, 'sending')
      if (!lease) return { outcome: Promise.resolve(rejectSend(target, { kind: 'rejected', code: 'generation-busy', message: '当前已有生成任务，请稍候。' }, intent)) }
      acceptingRef.current = id
      let acceptedSend: AcceptedSendContext
      let afterUser: Conversation
      try {
        const m = await attachPdfContexts({ id: newStableId(), role: 'user', content, images: imageIds, createdAt: now, updatedAt: now, ...(options.quickFollowUp ? { quickFollowUp: options.quickFollowUp } : {}) }, imageIds, now)
        const titled = conv.title === NEW_TITLE && content ? content.slice(0, 18) : conv.title
        const candidate: Conversation = { ...conv, title: titled, updatedAt: now, messages: [...conv.messages, m] }
        upsertState(candidate, { status: 'sending', sendError: undefined, sendErrorTarget: undefined })
        const prepared = await prepareAcceptedSendContext({
          threadRef: { type: 'root', conversationId: id },
          messagesBeforeAcceptance: conv.messages,
          candidateMessages: candidate.messages,
          effectiveTransitions: conv.promptTransitions ?? [],
          localTransitions: conv.promptTransitions ?? [],
          acceptedMessageId: m.id,
        })
        acceptedSend = prepared.context
        afterUser = { ...candidate, promptTransitions: prepared.nextLocalTransitions }
        upsertState(afterUser, { status: 'sending', sendError: undefined, sendErrorTarget: undefined })
        await commitAcceptedUserMessage(afterUser, id, draftSettingKey(id), options.draftDisposition ?? 'clear')
      } catch (e) {
        const rejected: RejectedOutcome = { kind: 'rejected', code: 'acceptance-failed', message: '消息发送失败，请重试。' }
        acceptingRef.current = null
        lease.release()
        upsertState(conv, { status: 'idle', sendError: undefined, sendErrorTarget: undefined })
        presentRejectedSend(target, rejected, intent)
        return { outcome: Promise.resolve(rejected) }
      }
      acceptingRef.current = null
      if ((options.draftDisposition ?? 'clear') === 'clear') clearDraftMemory(id)
      const outcome = runReplyStream(id, settings, acceptedSend, lease)
      return { outcome }
    })
    if (!locked.acquired) return rejectSend(target, { kind: 'rejected', code: 'generation-busy', message: '当前会话正在处理另一项操作，请稍候。' }, intent)
    return locked.value.outcome
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
    generationRegistry.cancelForConversation(id)
    // Invalidate any pending durable write for this conversation so a late checkpoint cannot
    // recreate the deleted row (P0-2).
    writeChains.delete(id)
    const conv = state.byId[id]
    const next = toState(state.list.filter(c => c.id !== id), state.current === id ? undefined : state.current)
    setState({ ...next, focusMessage: state.focusMessage?.conversationId === id ? undefined : state.focusMessage })
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

/** Root reply stream: runs AFTER the user message is accepted & persisted. */
/**
 * Root conversation target for the shared streaming engine. The engine is thread-agnostic;
 * this target binds it to the existing root Conversation (v1 behavior preserved). */
class RootReplyThread implements ReplyThread {
  readonly genKey: string
  private assistantId: StableId = ''
  constructor(private id: string) { this.genKey = genRootKey(id) }
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
  settleAssistant(status: 'failed' | 'aborted', message: string): void {
    const cur = state.byId[this.id]; if (!cur) return
    const last = cur.messages[cur.messages.length - 1]
    if (!last || last.id !== this.assistantId) return
    if (!last.content) {
      upsertState({ ...cur, updatedAt: Date.now(), messages: cur.messages.slice(0, -1) })
      return
    }
    const updatedMsg: Message = { ...last, status, error: message, updatedAt: Date.now() }
    upsertState({ ...cur, updatedAt: Date.now(), messages: [...cur.messages.slice(0, -1), updatedMsg] })
  }
  async persistFinal(): Promise<void> { const cur = state.byId[this.id]; if (cur) await persistConversation(cur) }
  async drainWrites(): Promise<void> { await drainWrites(this.id) }
  exists(): boolean { return !!state.byId[this.id] }
  setStreaming(): void { setState({ ...state, status: 'streaming', sendError: undefined, sendErrorTarget: undefined }) }
  setIdle(): void { setState({ ...state, status: 'idle', sendError: undefined, sendErrorTarget: undefined }) }
  setError(error: SendFailure): void { setSessionsSendError({ ...error, conversationId: this.id }) }
}

/** Fire-and-forget reply stream: runs AFTER the user message is accepted & persisted. */
async function runReplyStream(id: string, settings: ReturnType<typeof getSettingsSnapshot>, acceptedSend: AcceptedSendContext, lease: GenerationLease): Promise<SendOutcome> {
  if (!settings.apiKey) {
    const failure: SendFailure = { kind: 'failed', code: 'no-api-key', message: errorKindLabel('no-api-key') }
    lease.release()
    setSessionsSendError({ ...failure, conversationId: id })
    return failure
  }
  const controller = lease.controller
  const thread = new RootReplyThread(id)
  const outcome = await runThreadReply(thread, settings, controller, (c, assistantId) => {
    abortControllerRef = c
    activeGeneration = { conversationId: id, assistantId, controller: c }
  }, acceptedSend, lease)
  // The engine already flushed + drained + set status; clear ownership deterministically.
  activeGeneration = null
  abortControllerRef = null
  return outcome
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
