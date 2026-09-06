import type { DocumentNote } from './document-note-service'

export type NoteEditorSession = {
  documentId: string
  pageNumber: number
  key: string
  text: string
  loaded: boolean
  dirty: boolean
  timer: number | null
  lastSave: Promise<void> | null
}

export type NoteSaveWriter = (documentId: string, pageNumber: number, content: string) => Promise<DocumentNote | undefined>

export type NoteSaveHooks = {
  onSaved?: (session: NoteEditorSession, attemptedContent: string, currentContent: boolean) => void
  onError?: (session: NoteEditorSession, error: unknown) => void
}

/**
 * Flush one note snapshot without losing edits made while the write is in flight.
 * The caller's document-note service remains responsible for durable ordering and ownership.
 */
export function flushNoteEditorSession(session: NoteEditorSession, write: NoteSaveWriter, hooks: NoteSaveHooks = {}): Promise<void> {
  if (session.timer !== null) {
    window.clearTimeout(session.timer)
    session.timer = null
  }
  if (!session.loaded || !session.dirty) return session.lastSave ?? Promise.resolve()

  const attemptedContent = session.text
  const prior = session.lastSave ?? Promise.resolve()
  const save = prior.catch(() => undefined).then(async () => {
    try {
      await write(session.documentId, session.pageNumber, attemptedContent)
      const currentContent = session.text === attemptedContent
      session.dirty = !currentContent
      hooks.onSaved?.(session, attemptedContent, currentContent)
    } catch (error) {
      session.dirty = true
      hooks.onError?.(session, error)
      throw error
    }
  })
  session.lastSave = save
  return save
}
