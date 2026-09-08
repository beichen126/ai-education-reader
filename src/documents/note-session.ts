import type { DocumentNote } from './document-note-service'

export type NoteEditorSession = {
  documentId: string
  pageNumber: number
  key: string
  text: string
  loaded: boolean
  /** A successful read established the base snapshot this session may edit. */
  baseLoaded: boolean
  /** Independent write guard; UI disabled state is not a persistence guarantee. */
  writeEnabled: boolean
  dirty: boolean
  timer: number | null
  lastSave: Promise<void> | null
  pendingContent?: string
  editedDuringLoad?: boolean
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
  if (session.timer !== null) {
    window.clearTimeout(session.timer)
    session.timer = null
  }
  if (!session.baseLoaded || !session.writeEnabled || !session.dirty) return session.lastSave ?? Promise.resolve()

  const attemptedContent = session.text
  if (session.lastSave && session.pendingContent === attemptedContent) {
    return session.lastSave
  }
  session.pendingContent = attemptedContent
  let writeResult: Promise<DocumentNote | undefined>
  try {
    // Do not move this call into a promise callback. saveDocumentNote uses
    // this synchronous call site to register the service-level read barrier.
    writeResult = write(session.documentId, session.pageNumber, attemptedContent)
  } catch (error) {
    writeResult = Promise.reject(error)
  }
  // Observe the writer immediately so a rejection cannot become unhandled
  // while an older session result is still settling.
  const observedWrite = writeResult.then(value => value, error => { throw error })
  const prior = session.lastSave ?? Promise.resolve()
  const save = prior.catch(() => undefined).then(() => observedWrite).then(async () => {
    const currentContent = session.text === attemptedContent
    session.dirty = !currentContent
    hooks.onSaved?.(session, attemptedContent, currentContent)
  }).catch(error => {
    session.dirty = true
    hooks.onError?.(session, error)
    throw error
  })
  session.lastSave = save
  // Clear the deduplication marker after the ordered result settles. The
  // rejection handler is attached here as well, so this observer cannot create
  // an unhandled rejection of its own.
  void save.then(
    () => { if (session.pendingContent === attemptedContent) session.pendingContent = undefined },
    () => { if (session.pendingContent === attemptedContent) session.pendingContent = undefined },
  )
  return save
}
