export type ReaderProgressReason = 'navigation' | 'debounce' | 'close' | 'switch' | 'hidden' | 'pagehide' | 'retry' | 'manual' | 'bind'

export type ReaderProgressState = {
  ownerDocumentId: string | null
  currentPage: number
  confirmedPage: number
  dirty: boolean
  inFlight: boolean
  generation: number
  retryAttempt: number
  lastError?: string
}

export type FlushResult =
  | { ok: true; page: number }
  | { ok: false; page: number; error: unknown; terminal: boolean }

export type ReaderProgressBinding = {
  documentId: string
  generation: number
}

type TimerHandle = ReturnType<typeof setTimeout>
type WritePage = (documentId: string, page: number) => Promise<void>

type ReaderProgressOptions = {
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  setTimer?: (callback: () => void, delay: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
  onStateChange?: (state: ReaderProgressState) => void
  isTerminalError?: (error: unknown) => boolean
}

type PendingProgress = {
  page: number
  confirmedPage: number
  retryAttempt: number
  lastError?: string
  generation: number
}

type Session = {
  documentId: string
  currentPage: number
  confirmedPage: number
  dirty: boolean
  generation: number
  retryAttempt: number
  lastError?: string
  timer: TimerHandle | null
  retryTimer: TimerHandle | null
  inFlight: Promise<FlushResult> | null
  released: boolean
  terminal: boolean
}

const DEFAULT_DEBOUNCE_MS = 600
const DEFAULT_RETRY_BASE_MS = 800
const DEFAULT_RETRY_MAX_MS = 30_000

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error || '阅读位置保存失败')
}

function defaultIsTerminalError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'DocumentNotFoundError'
}

/**
 * Owns the durable reading-page lifecycle for one component instance.
 *
 * Session objects are intentionally independent from the currently bound owner. A
 * close/switch can therefore finish writing document A after document B has already
 * been bound without ever consulting B's mutable refs. Per-document tails serialize
 * A's old write and a later A write, which prevents a slow stale write from winning.
 */
export class ReaderProgressController {
  private readonly debounceMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly setTimer: (callback: () => void, delay: number) => TimerHandle
  private readonly clearTimer: (timer: TimerHandle) => void
  private readonly onStateChange?: (state: ReaderProgressState) => void
  private readonly isTerminalError: (error: unknown) => boolean
  private readonly writePage: WritePage
  private active: Session | null = null
  private generation = 0
  private readonly pendingByDocument = new Map<string, PendingProgress>()
  private readonly documentTails = new Map<string, Promise<void>>()

  constructor(writePage: WritePage, options: ReaderProgressOptions = {}) {
    this.writePage = writePage
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
    this.onStateChange = options.onStateChange
    this.isTerminalError = options.isTerminalError ?? defaultIsTerminalError
  }

  bind(documentId: string, initialPage: number): ReaderProgressBinding {
    if (!documentId) throw new Error('reader progress requires a document id')
    if (!Number.isInteger(initialPage) || initialPage < 1) throw new RangeError('invalid initial reader page')

    const previous = this.active
    if (previous) {
      // Preserve an unsaved same-document page immediately so a fast route rebind
      // cannot lose the in-memory value before the old release promise settles.
      if (previous.documentId === documentId && previous.dirty && !previous.terminal) this.rememberPending(previous)
      this.active = null
      void this.releaseSession(previous, 'switch')
    }

    const pending = this.pendingByDocument.get(documentId)
    if (pending) this.pendingByDocument.delete(documentId)
    const page = pending?.page ?? initialPage
    const session: Session = {
      documentId,
      currentPage: page,
      confirmedPage: pending?.confirmedPage ?? initialPage,
      dirty: !!pending,
      generation: ++this.generation,
      retryAttempt: pending?.retryAttempt ?? 0,
      lastError: pending?.lastError,
      timer: null,
      retryTimer: null,
      inFlight: null,
      released: false,
      terminal: false,
    }
    this.active = session
    if (pending) this.scheduleSession(session, this.debounceMs)
    this.emit()
    return { documentId, generation: session.generation }
  }

  observePage(page: number, _reason: ReaderProgressReason = 'navigation'): void {
    if (!Number.isInteger(page) || page < 1) throw new RangeError('invalid observed reader page')
    const session = this.active
    if (!session || session.released || session.terminal || session.currentPage === page) return
    session.currentPage = page
    session.dirty = true
    this.scheduleSession(session, this.debounceMs)
    this.emit()
  }

  schedule(): void {
    const session = this.active
    if (session) this.scheduleSession(session, this.debounceMs)
  }

  async flush(_reason: ReaderProgressReason = 'manual'): Promise<FlushResult> {
    const session = this.active
    if (!session) return { ok: true, page: 0 }
    this.clearSessionTimer(session)
    const result = await this.flushSession(session)
    this.emit()
    return result
  }

  async retry(): Promise<FlushResult> {
    const session = this.active
    if (!session || session.terminal) return { ok: false, page: session?.currentPage ?? 0, error: new Error('document progress is unavailable'), terminal: true }
    if (session.retryTimer !== null) {
      this.clearTimer(session.retryTimer)
      session.retryTimer = null
    }
    const result = await this.flush('retry')
    this.emit()
    return result
  }

  async release(_reason: ReaderProgressReason = 'close', binding?: ReaderProgressBinding): Promise<FlushResult> {
    const session = this.active
    if (!session) return { ok: true, page: 0 }
    if (binding && (session.documentId !== binding.documentId || session.generation !== binding.generation)) {
      return { ok: true, page: session.confirmedPage }
    }
    this.active = null
    return this.releaseSession(session, _reason)
  }

  snapshot(): ReaderProgressState {
    const session = this.active
    return session
      ? {
          ownerDocumentId: session.documentId,
          currentPage: session.currentPage,
          confirmedPage: session.confirmedPage,
          dirty: session.dirty,
          inFlight: session.inFlight !== null,
          generation: session.generation,
          retryAttempt: session.retryAttempt,
          ...(session.lastError ? { lastError: session.lastError } : {}),
        }
      : { ownerDocumentId: null, currentPage: 0, confirmedPage: 0, dirty: false, inFlight: false, generation: this.generation, retryAttempt: 0 }
  }

  private async releaseSession(session: Session, _reason: ReaderProgressReason): Promise<FlushResult> {
    session.released = true
    this.clearSessionTimer(session)
    const result = await this.flushSession(session)
    if (!result.ok) {
      if (!('terminal' in result && result.terminal) && session.dirty) this.rememberPending(session)
    } else if (!session.dirty) this.deletePendingIfOwned(session)
    this.emit()
    return result
  }

  private async flushSession(session: Session): Promise<FlushResult> {
    if (session.terminal) return { ok: false, page: session.currentPage, error: new Error('document no longer exists'), terminal: true }
    if (!session.dirty) return { ok: true, page: session.confirmedPage }

    while (session.dirty && !session.terminal) {
      if (session.inFlight) {
        const result = await session.inFlight
        if (!result.ok) return result
        continue
      }

      const targetPage = session.currentPage
      const previousTail = this.documentTails.get(session.documentId) ?? Promise.resolve()
      let operation: Promise<void>
      operation = previousTail.catch(() => undefined).then(() => this.writePage(session.documentId, targetPage))
      // The tail always settles, while operation retains the original failure for
      // this session. This prevents an unhandled rejection and still serializes writes.
      this.documentTails.set(session.documentId, operation.catch(() => undefined))
      const inFlight: Promise<FlushResult> = operation.then((): FlushResult => {
        session.confirmedPage = targetPage
        if (session.currentPage === targetPage) session.dirty = false
        session.retryAttempt = 0
        session.lastError = undefined
        this.deletePendingIfOwned(session)
        return { ok: true, page: targetPage }
      }, (error: unknown): FlushResult => {
        const terminal = this.isTerminalError(error)
        session.lastError = errorText(error)
        session.retryAttempt++
        if (terminal) {
          session.terminal = true
          session.dirty = false
          this.clearSessionTimer(session)
          this.deletePendingIfOwned(session)
        } else if (!session.released) {
          this.scheduleRetry(session)
        }
        return { ok: false, page: targetPage, error, terminal }
      })
      session.inFlight = inFlight
      const result = await inFlight
      if (session.inFlight === inFlight) session.inFlight = null
      if (!result.ok) return result
    }
    return { ok: true, page: session.confirmedPage }
  }

  private scheduleSession(session: Session, delay: number): void {
    if (session.released || session.terminal || !session.dirty) return
    this.clearSessionTimer(session)
    session.timer = this.setTimer(() => {
      session.timer = null
      void this.flushSession(session).then(() => this.emit()).catch(() => this.emit())
    }, Math.max(0, delay))
  }

  private scheduleRetry(session: Session): void {
    if (session.released || session.terminal || session.retryTimer !== null) return
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.max(0, session.retryAttempt - 1)))
    session.retryTimer = this.setTimer(() => {
      session.retryTimer = null
      void this.flushSession(session).then(() => this.emit()).catch(() => this.emit())
    }, delay)
  }

  private clearSessionTimer(session: Session): void {
    if (session.timer !== null) { this.clearTimer(session.timer); session.timer = null }
    if (session.retryTimer !== null) { this.clearTimer(session.retryTimer); session.retryTimer = null }
  }

  private rememberPending(session: Session): void {
    this.pendingByDocument.set(session.documentId, {
      page: session.currentPage,
      confirmedPage: session.confirmedPage,
      retryAttempt: session.retryAttempt,
      lastError: session.lastError,
      generation: session.generation,
    })
  }

  private deletePendingIfOwned(session: Session): void {
    const pending = this.pendingByDocument.get(session.documentId)
    if (!pending || pending.generation === session.generation) this.pendingByDocument.delete(session.documentId)
  }

  private emit(): void { this.onStateChange?.(this.snapshot()) }
}
