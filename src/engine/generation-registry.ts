/**
 * Generation registry — the single ownership record for ONE active model generation
 * (root chat, branch chat, or artifact).
 *
 * A lease is the only authority allowed to transition/release its generation. The
 * token matters even when a caller reuses the same logical key: a late completion
 * from an older generation can never release a newer owner.
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
}

let active: ActiveGeneration | null = null
const subs = new Set<() => void>()
function emit() { for (const f of subs) f() }

function sameOwner(key: string, controller: AbortController, token?: symbol): boolean {
  return !!active
    && active.key === key
    && active.controller === controller
    && (token === undefined || active.token === token)
}

function makeLease(key: string, token: symbol, controller: AbortController): GenerationLease {
  return {
    key,
    token,
    controller,
    setStreaming(): boolean {
      if (!sameOwner(key, controller, token)) return false
      if (active!.status !== 'streaming') { active!.status = 'streaming'; emit() }
      return true
    },
    release(): void {
      if (!sameOwner(key, controller, token)) return
      active = null
      emit()
    },
    isCurrent(): boolean { return sameOwner(key, controller, token) },
  }
}

export const generationRegistry = {
  /** Atomically acquire the one global generation slot. */
  acquire(key: string, controller: AbortController, status: GenerationStatus = 'sending'): GenerationLease | null {
    if (active) return null
    const token = Symbol('generation:' + key)
    active = { key, token, controller, status }
    emit()
    return makeLease(key, token, controller)
  },

  /**
   * Compatibility entry point for older callers. A re-entry is valid only when it
   * names the exact same controller; a same-key different controller is rejected.
   */
  begin(key: string, controller: AbortController, status: GenerationStatus): boolean {
    if (active) {
      if (!sameOwner(key, controller)) return false
      if (active.status !== status) { active.status = status; emit() }
      return true
    }
    return this.acquire(key, controller, status) !== null
  },
  setStatus(status: GenerationStatus): void {
    if (active && active.status !== status) { active.status = status; emit() }
  },
  getStatus(): GenerationStatus { return active ? active.status : 'idle' },
  getKey(): string | null { return active ? active.key : null },
  isBusy(): boolean { return !!active },
  current(): ActiveGeneration | null { return active },
  /** Token-aware release. The optional legacy form is retained for old adapters. */
  end(key: string, token?: symbol): void {
    if (active && active.key === key && (token === undefined || active.token === token)) {
      active = null
      emit()
    }
  },
  /** Abort + release ownership unconditionally (the unified stop action). */
  cancel(): void {
    if (active) {
      try { active.controller.abort() } catch { /* ignore */ }
      active = null
      emit()
    }
  },
  /** Abort + release the active generation belonging to a conversation. */
  cancelForConversation(conversationId: string): void {
    if (!active) return
    const k = active.key
    if (k === 'root:' + conversationId || k.startsWith('branch:' + conversationId + ':')) {
      try { active.controller.abort() } catch { /* ignore */ }
      active = null
      emit()
    }
  },
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } },
}

/** Stable string keys for generation ownership. */
export function genRootKey(conversationId: string): string { return 'root:' + conversationId }
export function genBranchKey(conversationId: string, branchId: string): string { return 'branch:' + conversationId + ':' + branchId }
