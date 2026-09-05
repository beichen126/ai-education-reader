/**
 * Generation registry — the single ownership record for ONE active model generation
 * (root chat, branch chat, or artifact). Both the root conversation stream and every
 * branch stream register here, so the global status bar, the unified 停止生成 action,
 * the AbortController, and the lock are shared — never two competing trackers.
 *
 * Status transitions: sending -> streaming -> idle (or -> idle on stop/error).
 * `cancel()` aborts the active controller and releases the ownership unconditionally.
 */

export type GenerationStatus = 'idle' | 'sending' | 'streaming'

type ActiveGeneration = {
  key: string
  controller: AbortController
  status: GenerationStatus
}

let active: ActiveGeneration | null = null
const subs = new Set<() => void>()
function emit() { for (const f of subs) f() }

export const generationRegistry = {
  /** Begin a generation. Returns false when another generation is already active (one-at-a-time). */
  begin(key: string, controller: AbortController, status: GenerationStatus): boolean {
    if (active) {
      if (active.key === key) { active.status = status; emit(); return true }
      return false
    }
    active = { key, controller, status }
    emit()
    return true
  },
  setStatus(status: GenerationStatus): void {
    if (active) { active.status = status; emit() }
  },
  getStatus(): GenerationStatus { return active ? active.status : 'idle' },
  getKey(): string | null { return active ? active.key : null },
  isBusy(): boolean { return !!active },
  current(): ActiveGeneration | null { return active },
  /** End ownership for a specific key (no-op unless it is the active one). */
  end(key: string): void {
    if (active && active.key === key) { active = null; emit() }
  },
  /** Abort + release ownership unconditionally (the unified stop action). */
  cancel(): void {
    if (active) { try { active.controller.abort() } catch { /* ignore */ }; active = null; emit() }
  },
  /** Abort + release the active generation belonging to a conversation (root or any of its branches). */
  cancelForConversation(conversationId: string): void {
    if (!active) return
    const k = active.key
    if (k === 'root:' + conversationId || k.startsWith('branch:' + conversationId + ':')) { try { active.controller.abort() } catch { /* ignore */ }; active = null; emit() }
  },
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } },
}

/** Stable string keys for generation ownership. */
export function genRootKey(conversationId: string): string { return 'root:' + conversationId }
export function genBranchKey(conversationId: string, branchId: string): string { return 'branch:' + conversationId + ':' + branchId }
