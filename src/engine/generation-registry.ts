/**
 * Chat generations own one slot per conversation. Root and branch routes in that
 * conversation share the slot because they write related history. Legacy jobs
 * such as artifact generation still take an exclusive slot.
 */
export type GenerationStatus = 'idle' | 'sending' | 'streaming'

export type GenerationLease = {
  readonly key: string
  readonly token: symbol
  readonly controller: AbortController
  setStreaming(): boolean
  release(): void
  isCurrent(): boolean
}

type ActiveGeneration = {
  key: string
  token: symbol
  controller: AbortController
  status: GenerationStatus
  conversationId?: string
}

const active = new Map<string, ActiveGeneration>()
const subs = new Set<() => void>()
const emit = () => { for (const listener of subs) listener() }

function firstActive(): ActiveGeneration | null {
  return active.values().next().value ?? null
}

function addGeneration(key: string, controller: AbortController, status: GenerationStatus, conversationId?: string): GenerationLease {
  const token = Symbol('generation:' + key)
  const job = { key, token, controller, status, conversationId }
  active.set(key, job)
  emit()
  const ownsSlot = () => active.get(key) === job
  const isCurrent = () => ownsSlot() && !controller.signal.aborted
  return {
    key, token, controller, isCurrent,
    setStreaming() {
      if (!isCurrent()) return false
      if (job.status !== 'streaming') { job.status = 'streaming'; emit() }
      return true
    },
    release() { if (ownsSlot()) { active.delete(key); emit() } },
  }
}

export const generationRegistry = {
  acquire(key: string, controller: AbortController, status: GenerationStatus = 'sending'): GenerationLease | null {
    if (active.size) return null
    return addGeneration(key, controller, status)
  },
  acquireChat(key: string, conversationId: string, controller: AbortController): GenerationLease | null {
    if (active.has(key) || this.exclusiveStatus() !== 'idle' || this.keyForConversation(conversationId)) return null
    return addGeneration(key, controller, 'sending', conversationId)
  },
  begin(key: string, controller: AbortController, status: GenerationStatus): boolean {
    const job = active.get(key)
    if (!job) return this.acquire(key, controller, status) !== null
    if (job.controller !== controller) return false
    if (job.status !== status) { job.status = status; emit() }
    return true
  },
  setStatus(status: GenerationStatus): void {
    const job = firstActive()
    if (job && job.status !== status) { job.status = status; emit() }
  },
  getStatus(key?: string): GenerationStatus { return (key === undefined ? firstActive() : active.get(key))?.status ?? 'idle' },
  getKey(): string | null { return firstActive()?.key ?? null },
  isBusy(): boolean { return active.size > 0 },
  current(): ActiveGeneration | null { return firstActive() },
  exclusiveStatus(): GenerationStatus {
    const job = firstActive()
    return job && job.conversationId === undefined ? job.status : 'idle'
  },
  keyForConversation(conversationId: string): string | null {
    for (const job of active.values()) {
      if (job.conversationId === conversationId || job.key === genRootKey(conversationId) || job.key.startsWith('branch:' + conversationId + ':')) return job.key
    }
    return null
  },
  otherChatKey(viewingKey: string): string | null {
    for (const job of active.values()) if (job.conversationId && job.key !== viewingKey) return job.key
    return null
  },
  end(key: string, token?: symbol): void {
    const job = active.get(key)
    if (job && (token === undefined || token === job.token)) { active.delete(key); emit() }
  },
  /** Keep the stopped chat reserved until its accepted reply has settled. */
  stop(key: string): void {
    active.get(key)?.controller.abort()
  },
  cancel(): void {
    const jobs = [...active.values()]
    if (!jobs.length) return
    active.clear()
    for (const job of jobs) job.controller.abort()
    emit()
  },
  cancelForConversation(conversationId: string): void {
    const key = this.keyForConversation(conversationId)
    if (key) {
      this.stop(key)
      this.end(key)
    }
  },
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } },
}

export function genRootKey(conversationId: string): string { return 'root:' + conversationId }
export function genBranchKey(conversationId: string, branchId: string): string { return 'branch:' + conversationId + ':' + branchId }
