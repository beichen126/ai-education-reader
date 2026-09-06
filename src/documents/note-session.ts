import type { DocumentNote } from './document-note-service'
import { traceNoteLifecycle } from './note-debug'

export type NoteEditorSession = {
  documentId: string
  pageNumber: number
  key: string
  text: string
  loaded: boolean
  dirty: boolean
  timer: number | null
  lastSave: Promise<void> | null
  pendingContent?: string
}

export type NoteSaveWriter = (documentId: string, pageNumber: number, content: string) => Promise<DocumentNote | undefined>

export type NoteSaveHooks = {
  onSaved?: (session: NoteEditorSession, attemptedContent: string, currentContent: boolean) => void
  onError?: (session: NoteEditorSession, error: unknown) => void
}

/**
 * Flush one note snapshot without losing edits made while the write is in flight.
 * The writer is invoked synchronously so a durable service can register its
 * same-key write barrier before a close/reopen read starts. The caller's
 * document-note service remains responsible for durable ordering and ownership.
 */
export function flushNoteEditorSession(session: NoteEditorSession, write: NoteSaveWriter, hooks: NoteSaveHooks = {}): Promise<void> {
  traceNoteLifecycle('note-flush-invoked', {
    key: session.key,
    loaded: session.loaded,
    dirty: session.dirty,
    text: session.text,
    hasTimer: session.timer !== null,
    hasLastSave: session.lastSave !== null,
    pendingContent: session.pendingContent ?? null,
  })
  if (session.timer !== null) {
    window.clearTimeout(session.timer)
    session.timer = null
  }
  if (!session.loaded || !session.dirty) {
    traceNoteLifecycle('note-flush-skipped', { key: session.key, reason: !session.loaded ? 'not-loaded' : 'clean' })
    return session.lastSave ?? Promise.resolve()
  }

  const attemptedContent = session.text
  if (session.lastSave && session.pendingContent === attemptedContent) {
    traceNoteLifecycle('note-flush-deduped', { key: session.key, content: attemptedContent })
    return session.lastSave
  }
  session.pendingContent = attemptedContent
  let writeResult: Promise<DocumentNote | undefined>
  try {
    // Do not move this call into a promise callback. saveDocumentNote uses
    // this synchronous call site to register the service-level read barrier.
    traceNoteLifecycle('note-flush-writer-invoking', { key: session.key, content: attemptedContent })
    writeResult = write(session.documentId, session.pageNumber, attemptedContent)
    traceNoteLifecycle('note-flush-writer-returned', { key: session.key, content: attemptedContent })
  } catch (error) {
    traceNoteLifecycle('note-flush-writer-threw', { key: session.key, content: attemptedContent, error: String(error) })
    writeResult = Promise.reject(error)
  }
  // Observe the writer immediately so a rejection cannot become unhandled
  // while an older session result is still settling.
  const observedWrite = writeResult.then(value => {
    traceNoteLifecycle('note-flush-writer-resolved', { key: session.key, content: attemptedContent })
    return value
  }, error => {
    traceNoteLifecycle('note-flush-writer-rejected', { key: session.key, content: attemptedContent, error: String(error) })
    throw error
  })
  const prior = session.lastSave ?? Promise.resolve()
  const save = prior.catch(() => undefined).then(() => observedWrite).then(async () => {
    const currentContent = session.text === attemptedContent
    session.dirty = !currentContent
    traceNoteLifecycle('note-flush-save-completed', { key: session.key, content: attemptedContent, currentContent, dirty: session.dirty })
    hooks.onSaved?.(session, attemptedContent, currentContent)
  }).catch(error => {
    session.dirty = true
    traceNoteLifecycle('note-flush-save-failed', { key: session.key, content: attemptedContent, error: String(error) })
    hooks.onError?.(session, error)
    throw error
  })
  session.lastSave = save
  // Clear the deduplication marker after the ordered result settles. The
  // rejection handler is attached here as well, so this observer cannot create
  // an unhandled rejection of its own.
  void save.then(
    () => {
      if (session.pendingContent === attemptedContent) session.pendingContent = undefined
      traceNoteLifecycle('note-flush-pending-cleared', { key: session.key, content: attemptedContent, outcome: 'resolved' })
    },
    () => {
      if (session.pendingContent === attemptedContent) session.pendingContent = undefined
      traceNoteLifecycle('note-flush-pending-cleared', { key: session.key, content: attemptedContent, outcome: 'rejected' })
    },
  )
  return save
}
