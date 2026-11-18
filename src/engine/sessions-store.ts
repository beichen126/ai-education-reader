import { useSyncExternalStore } from 'react'
import { type Conversation, type Message, type Attachment, type StableId, type DraftDisposition, type QuickFollowUpMetadata, newStableId, NEW_TITLE } from './types'
import { sanitizeTitle } from './session-title'
import { getSetting, setSetting, getConversation, saveConversation, saveConversationRenameAndSyncCards, deleteConversation, listConversations, commitAcceptedUserMessage, updateConversationOrganization, type ConversationOrganizationAction } from '../storage/storage'
import { getSettingsSnapshot } from './settings-store'
import { providerPreflight } from '../api/chat-provider'
import { streamTextChat, DeepSeekError, errorKindLabel, buildApiMessages, buildContextMessages, buildRequestMessages, countImageParts, isVisionModel, exceedsVisionImageCount } from '../api/deepseek'
import { toDataUrl, deleteAttachment, attachmentErrorLabel, AttachmentError } from './attachment-service'
import { deleteConvAnnotations } from '../annotations/annotation-store'
import { getDraft, deleteDraft, initDrafts, draftSettingKey, clearDraftMemory } from './draft-store'
import { runThreadReply, type ReplyMetadata, type ReplyThread } from './stream-reply'
import { generationRegistry, genBranchKey, genRootKey, type GenerationLease } from './generation-registry'
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
  sendErrors: ReadonlyMap<string, string>
}

let state: SessionsState = { list: [], byId: {}, current: undefined, ready: false, status: 'idle', sendError: undefined, sendErrors: new Map() }
const subs = new Set<() => void>()
function setState(next: SessionsState) { state = next; subs.forEach(f => f()) }
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
// Legacy observers use an aggregate status. The composer subscribes to its own
// generation key so another conversation cannot change its controls.
generationRegistry.subscribe(() => {
  const status = generationRegistry.getStatus()
  setState({ ...state, status: status === 'idle' && state.sendErrorTarget?.conversationId === state.current && state.sendError ? 'error' : status })
})
const getSnapshot = () => state
export function useSessions<T>(sel: (s: SessionsState) => T): T { return useSyncExternalStore(subscribe, () => sel(state)) }
export function getSessionsStatus(): RequestStatus { return state.status }
export function getSessionsSendError(): string | undefined { return state.sendError }
export function getSessionsSendErrorTarget(): SendTarget | undefined { return state.sendErrorTarget }
export function getSessionsCurrent(): string | undefined { return state.current }
export function getSessionsFocusTarget(): MessageFocusTarget | undefined { return state.focusMessage }
function sendErrorKey({ conversationId, branchId }: SendTarget): string {
  return branchId ? genBranchKey(conversationId, branchId) : genRootKey(conversationId)
}
export function setSessionsSendError(error: SendErrorState): void {
  setState({ ...state, status: 'error', sendError: error.message, sendErrorTarget: { conversationId: error.conversationId, ...(error.branchId ? { branchId: error.branchId } : {}) }, sendErrors: new Map(state.sendErrors).set(sendErrorKey(error), error.message) })
}
export function clearSessionsSendError(target?: SendTarget): void {
  const key = target && sendErrorKey(target)
  if (key ? !state.sendErrors.has(key) : !state.sendErrors.size && state.status !== 'error') return
  const sendErrors = new Map(state.sendErrors)
  if (key) sendErrors.delete(key)
  else sendErrors.clear()
  const clearLatest = !key || (state.sendErrorTarget && sendErrorKey(state.sendErrorTarget) === key)
  setState({ ...state, sendErrors, ...(clearLatest ? { status: generationRegistry.getStatus(), sendError: undefined, sendErrorTarget: undefined } : {}) })
}

/** Present every rejected outcome through one policy/state transition. */
export function presentRejectedSend(target: SendTarget, outcome: RejectedSend, intent: SendIntent = 'internal'): RejectedSend {
  if (shouldPresentRejectedSend(outcome, intent)) setSessionsSendError({ ...outcome, ...target })
  else clearSessionsSendError(target)
  return outcome
}

export type SendUserMessageOptions = {
  quickFollowUp?: QuickFollowUpMetadata
  documents?: import('../api/deepseek-documents').DeepSeekDocument[]
  draftDisposition?: DraftDisposition
}

function index(list: Conversation[]): Record<string, Conversation> {
  const m: Record<string, Conversation> = {}; for (const c of list) m[c.id] = c; return m
}
function sortList(list: Conversation[]): Conversation[] { return [...list].sort((a, b) => b.updatedAt - a.updatedAt) }
function toState(list: Conversation[], current?: string, ready = state.ready, status = state.status, sendError = state.sendError, sendErrorTarget = state.sendErrorTarget): SessionsState {
  const sorted = sortList(list)
  return { list: sorted, byId: index(sorted), current: current ?? defaultConversationId(sorted), ready, status, sendError, sendErrorTarget, sendErrors: state.sendErrors, focusMessage: state.focusMessage }
}
function defaultConversationId(sorted: Conversation[]): string | undefined {
  return (sorted.find(conversation => conversation.archivedAt === undefined) ?? sorted[0])?.id
}
function upsertState(conv: Conversation) {
  setState(toState(state.list.map(c => c.id === conv.id ? conv : c), state.current))
}
function preserveConversationMetadata(conversation: Conversation): Conversation {
  const current = state.byId[conversation.id]
  if (!current) return conversation
  return {
    ...conversation,
    pinnedAt: current.pinnedAt,
    archivedAt: current.archivedAt,
    ...(current.titleManuallySet ? { title: current.title, titleManuallySet: true, updatedAt: Math.max(conversation.updatedAt, current.updatedAt) } : {}),
  }
}
const LAST_CONV = 'lastConversationId'

type PendingSend = { outcome: Promise<SendOutcome> }
type RejectedOutcome = Extract<SendOutcome, { kind: 'rejected' }>
function rejectSend(target: SendTarget, outcome: RejectedOutcome, intent: SendIntent): RejectedOutcome {
  return presentRejectedSend(target, outcome, intent)
}


/** Per-conversation serialized durable-write queue. Every persistence of a conversation's
 *  streaming assistant content is chained AFTER the previous durable write, so a stale
 *  partial checkpoint can NEVER overwrite a newer durable revision (P0-2 monotonic writes).
 *  The map entry is cleared once the chain drains. */
const writeChains = new Map<string, Promise<void>>()
/** Exported for deterministic regression tests (P0-2 ordering). */
export function enqueueWrite(convId: string, write: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(convId) || Promise.resolve()
  const next = prev.then(write)
  const settled = next.catch((e) => { console.error('[stream] durable write failed', convId, e) })
  writeChains.set(convId, settled)
  void settled.then(() => { if (writeChains.get(convId) === settled) writeChains.delete(convId) })
  return next
}
/** Resolve when all queued durable writes for a conversation have settled (used to await the
 *  full queue before returning/clearing ownership on completion/abort/error). */
function drainWrites(convId: string): Promise<void> { return writeChains.get(convId) || Promise.resolve() }


export const sessionsActions = {
  async newChat(): Promise<string> {
    const c = makeSession()
    setState({ ...toState([c, ...state.list], c.id), focusMessage: undefined })
    await saveConversation(c)
    if (state.current === c.id) await setSetting(LAST_CONV, c.id)
    return c.id
  },
  async open(id: string) {
    if (!state.byId[id]) return
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
  stopGenerating(key?: string) { if (key) generationRegistry.stop(key); else generationRegistry.cancel() },
  /**
   * Send a user message and resolve with the terminal outcome. Acceptance still happens
   * before streaming, but the mutation lock is released before the model request runs.
   */
  async sendUserMessage(id: string, content: string, imageIds: StableId[] = [], options: SendUserMessageOptions = {}): Promise<SendOutcome> {
    const target: SendTarget = { conversationId: id }
    const intent: SendIntent = options.quickFollowUp ? 'quick-follow-up' : 'composer'
    clearSessionsSendError(target)
    const locked = await tryWithConversationMutationLock<PendingSend>(id, async () => {
      const conv = state.byId[id]
      if (!conv) return { outcome: Promise.resolve(rejectSend(target, { kind: 'rejected', code: 'conversation-not-found', message: '当前会话不存在。' }, intent)) }
      const invalidInput = validateSendInput(content, imageIds, options.quickFollowUp)
      if (invalidInput) return { outcome: Promise.resolve(rejectSend(target, invalidInput, intent)) }
      const settings = getSettingsSnapshot()
      const now = Date.now()
      const controller = new AbortController()
      const lease = generationRegistry.acquireChat(genRootKey(id), id, controller)
      if (!lease) return { outcome: Promise.resolve(rejectSend(target, { kind: 'rejected', code: 'generation-busy', message: '当前已有生成任务，请稍候。' }, intent)) }
      let acceptedSend: AcceptedSendContext
      let afterUser: Conversation
      try {
        const providerRejection = await providerPreflight(settings, controller.signal)
        if (!lease.isCurrent()) { lease.release(); return { outcome: Promise.resolve({ kind: 'aborted' } as const) } }
        if (providerRejection) { lease.release(); return { outcome: Promise.resolve(rejectSend(target, providerRejection, intent)) } }
        const m = await attachPdfContexts({ id: newStableId(), role: 'user', content, ...(options.documents?.length ? { documents: options.documents.map(d=>({...d})) } : {}), images: imageIds, createdAt: now, updatedAt: now, ...(options.quickFollowUp ? { quickFollowUp: options.quickFollowUp } : {}) }, imageIds, now)
        const titled = conv.title === NEW_TITLE && content ? content.slice(0, 18) : conv.title
        const candidate: Conversation = { ...conv, title: titled, updatedAt: now, messages: [...conv.messages, m] }
        if (!lease.isCurrent()) { lease.release(); return { outcome: Promise.resolve({ kind: 'aborted' } as const) } }
        upsertState(preserveConversationMetadata(candidate))
        const prepared = await prepareAcceptedSendContext({
          threadRef: { type: 'root', conversationId: id },
          messagesBeforeAcceptance: conv.messages,
          candidateMessages: candidate.messages,
          effectiveTransitions: conv.promptTransitions ?? [],
          localTransitions: conv.promptTransitions ?? [],
          acceptedMessageId: m.id,
        })
        acceptedSend = prepared.context
        afterUser = preserveConversationMetadata({ ...candidate, promptTransitions: prepared.nextLocalTransitions })
        if (!lease.isCurrent()) {
          lease.release()
          if (state.byId[id]) upsertState(preserveConversationMetadata(conv))
          return { outcome: Promise.resolve({ kind: 'aborted' } as const) }
        }
        upsertState(afterUser)
        const viewed = state.current ?? id
        await commitAcceptedUserMessage(afterUser, viewed, draftSettingKey(id), options.draftDisposition ?? 'clear')
        if (state.current && state.current !== viewed) void setSetting(LAST_CONV, state.current).catch(() => {})
      } catch (e) {
        const rejected: RejectedOutcome = { kind: 'rejected', code: 'acceptance-failed', message: '消息发送失败，请重试。' }
        lease.release()
        if (state.byId[id]) upsertState(preserveConversationMetadata(conv))
        presentRejectedSend(target, rejected, intent)
        return { outcome: Promise.resolve(rejected) }
      }
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
    const updated: Conversation = { ...conv, title: clean, titleManuallySet: true, updatedAt: Date.now() }
    upsertState(updated)
    await enqueueWrite(id, async () => {
      if (state.byId[id]) await saveConversationRenameAndSyncCards(id, clean, updated.updatedAt)
    })
  },
  async organize(id: string, action: ConversationOrganizationAction): Promise<boolean> {
    if (!state.byId[id]) return false
    const organization = await updateConversationOrganization(id, action)
    const current = state.byId[id]
    if (!current || !organization) return false
    upsertState({ ...current, ...organization })
    return true
  },
  async remove(id: string) {
    // If a reply stream is actively generating for THIS conversation, abort it. It must
    // never resurrect a deleted conversation or recreate deleted attachments/messages.
    generationRegistry.cancelForConversation(id)
    const conv = state.byId[id]
    const next = toState(state.list.filter(c => c.id !== id), state.current === id ? undefined : state.current)
    setState({ ...next, focusMessage: state.focusMessage?.conversationId === id ? undefined : state.focusMessage })
    await drainWrites(id)
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
    await setSetting(LAST_CONV, state.current ?? '')
  },
}

/** Durable save routed through the per-conversation serialized write queue (P0-2). Each
 *  checkpoint/final write is chained AFTER the previous durable write so a stale partial can
 *  never overwrite a newer revision. Never throws (a failed write must not corrupt the
 *  in-memory stream); the chain keeps the next queued write alive regardless. */
export async function persistConversation(conv: Conversation): Promise<void> {
  // Guard: never resurrect a conversation that was deleted while a write was queued.
  await enqueueWrite(conv.id, async () => { if (state.byId[conv.id]) await saveConversation(conv) }).catch(() => {})
}

/** Root reply stream: runs AFTER the user message is accepted & persisted. */
/**
 * Root conversation target for the shared streaming engine. The engine is thread-agnostic;
 * this target binds it to the existing root Conversation (v1 behavior preserved). */
class RootReplyThread implements ReplyThread {
  readonly genKey: string
  private assistantId: StableId = ''
  constructor(private id: string) { this.genKey = genRootKey(id) }
  acceptTitle(title: string): void {
    const cur = state.byId[this.id]
    if (!cur || cur.titleManuallySet || cur.messages.filter(m=>m.role==='user').length!==1) return
    const clean = sanitizeTitle(title); if (clean) upsertState({...cur,title:clean})
  }
  getContextMessages(): Message[] { return state.byId[this.id]?.messages ?? [] }
  createAssistantPlaceholder(assistantId: StableId, now: number): void {
    this.assistantId = assistantId
    const cur = state.byId[this.id]; if (!cur) return
    const placeholder: Message = { id: assistantId, role: 'assistant', content: '', images: [], createdAt: now, updatedAt: now }
    upsertState({ ...cur, updatedAt: now, messages: [...cur.messages, placeholder] })
  }
  updateAssistantContent(content: string, usage?: import('./token-usage').TokenUsage, metadata?: ReplyMetadata): void {
    const cur = state.byId[this.id]; if (!cur) return
    const last = cur.messages[cur.messages.length - 1]
    if (!last || last.id !== this.assistantId) return
    if (last.content === content && !usage && !metadata) return
    const updatedMsg: Message = { ...last, content, ...metadata, ...(usage ? { tokenUsage: usage } : {}), updatedAt: Date.now() }
    upsertState({ ...cur, updatedAt: Date.now(), messages: [...cur.messages.slice(0, -1), updatedMsg] })
  }
  persistCheckpoint(content: string): void {
    const cur = state.byId[this.id]; if (!cur) return
    const last = cur.messages[cur.messages.length - 1]
    if (!last || last.id !== this.assistantId) return
    const updatedMsg: Message = { ...last, content, updatedAt: Date.now() }
    const updated: Conversation = { ...cur, updatedAt: Date.now(), messages: [...cur.messages.slice(0, -1), updatedMsg] }
    void persistConversation(updated)
  }
  settleAssistant(status: 'failed' | 'aborted', message: string): void {
    const cur = state.byId[this.id]; if (!cur) return
    const last = cur.messages[cur.messages.length - 1]
    if (!last || last.id !== this.assistantId) return
    if (!last.content && !last.reasoning) {
      upsertState({ ...cur, updatedAt: Date.now(), messages: cur.messages.slice(0, -1) })
      return
    }
    const updatedMsg: Message = { ...last, status, error: message, updatedAt: Date.now() }
    upsertState({ ...cur, updatedAt: Date.now(), messages: [...cur.messages.slice(0, -1), updatedMsg] })
  }
  async persistFinal(): Promise<void> { const cur = state.byId[this.id]; if (cur) await persistConversation(cur) }
  async drainWrites(): Promise<void> { await drainWrites(this.id) }
  exists(): boolean { return !!state.byId[this.id] }
  setStreaming(): void { /* the generation lease publishes status */ }
  setIdle(): void { /* the generation lease publishes status */ }
  setError(error: SendFailure): void { setSessionsSendError({ ...error, conversationId: this.id }) }
}

/** Fire-and-forget reply stream: runs AFTER the user message is accepted & persisted. */
async function runReplyStream(id: string, settings: ReturnType<typeof getSettingsSnapshot>, acceptedSend: AcceptedSendContext, lease: GenerationLease): Promise<SendOutcome> {
  if (settings.chatProvider !== 'openai-local' && !settings.apiKey) {
    const failure: SendFailure = { kind: 'failed', code: 'no-api-key', message: errorKindLabel('no-api-key') }
    lease.release()
    setSessionsSendError({ ...failure, conversationId: id })
    return failure
  }
  return runThreadReply(new RootReplyThread(id), settings, lease.controller, undefined, acceptedSend, lease)
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
  const lastOk = last && convs.some(c => c.id === last) ? last : defaultConversationId(convs)
  await initDrafts(convs.map(c => c.id))
  setState(toState(convs, lastOk, true))
  if (last !== lastOk) await setSetting(LAST_CONV, lastOk)
}
