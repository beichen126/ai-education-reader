import type { DocumentNote } from './document-types'

export type NoteAvailability =
  | { kind: 'loading'; key: string }
  | { kind: 'empty'; key: string }
  | { kind: 'existing'; key: string }
  | { kind: 'error'; key: string; persisted: NotePersistedState; cachedContent?: string }

export type NotePersistedState = 'unknown' | 'empty' | 'existing'

export type NoteReader = (documentId: string, pageNumber: number) => Promise<DocumentNote | undefined>

export function noteKey(documentId: string, pageNumber: number): string {
  return documentId + ':' + pageNumber
}

export function noteHasContent(content: string | undefined): boolean {
  return !!content && content.trim().length > 0
}

export function notePersistedState(note: DocumentNote | undefined): NotePersistedState {
  if (note === undefined) return 'unknown'
  return noteHasContent(note?.content) ? 'existing' : 'empty'
}

export function noteAvailabilityFrom(noteKeyValue: string, note: DocumentNote | undefined): NoteAvailability {
  return notePersistedState(note) === 'existing'
    ? { kind: 'existing', key: noteKeyValue }
    : { kind: 'empty', key: noteKeyValue }
}

export type NoteAvailabilityRequest = { key: string; generation: number }

export class NoteAvailabilityGate {
  private generation = 0
  private activeKey = ''

  begin(key: string): NoteAvailabilityRequest {
    this.activeKey = key
    return { key, generation: ++this.generation }
  }

  accepts(request: NoteAvailabilityRequest): boolean {
    return request.key === this.activeKey && request.generation === this.generation
  }
}

/**
 * One read promise/cache per document page. The Reader uses this for both the
 * closed-state existence preload and the editor session, so opening the panel
 * cannot start a second read that races the preload result.
 */
export class NoteReadCache {
  private readonly resolved = new Map<string, DocumentNote | undefined>()
  private readonly pending = new Map<string, Promise<DocumentNote | undefined>>()
  private readonly revisions = new Map<string, number>()

  constructor(private readonly reader: NoteReader) {}

  read(documentId: string, pageNumber: number): Promise<DocumentNote | undefined> {
    const key = noteKey(documentId, pageNumber)
    if (this.resolved.has(key)) return Promise.resolve(this.resolved.get(key))
    const pending = this.pending.get(key)
    if (pending) return pending

    let request: Promise<DocumentNote | undefined>
    try {
      request = this.reader(documentId, pageNumber)
    } catch (error) {
      request = Promise.reject(error)
    }
    const revision = this.revisions.get(key) ?? 0
    let tracked: Promise<DocumentNote | undefined>
    tracked = request.then(note => {
      if ((this.revisions.get(key) ?? 0) === revision) this.resolved.set(key, note)
      if (this.pending.get(key) === tracked) this.pending.delete(key)
      return note
    }, error => {
      if (this.pending.get(key) === tracked) this.pending.delete(key)
      throw error
    })
    this.pending.set(key, tracked)
    return tracked
  }

  remember(documentId: string, pageNumber: number, note: DocumentNote | undefined): void {
    const key = noteKey(documentId, pageNumber)
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    this.resolved.set(key, note)
    this.pending.delete(key)
  }

  peek(documentId: string, pageNumber: number): DocumentNote | undefined {
    return this.resolved.get(noteKey(documentId, pageNumber))
  }
}
