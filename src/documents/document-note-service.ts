import { idbDelete, idbGet, idbGetAll, idbGetAllByIndex, idbSaveDocumentNote } from '../storage/idb'
import type { DocumentNote } from './document-types'
export type { DocumentNote } from './document-types'

function noteId(documentId: string, pageNumber: number): string {
  return documentId + '/page-' + pageNumber
}

// Writes for the same document/page are serialized here as a second line of
// defense. The IndexedDB transaction below protects document ownership; this
// queue protects ordering when several async saves are already in flight.
const saveQueues = new Map<string, Promise<void>>()

export async function getDocumentNote(documentId: string, pageNumber: number): Promise<DocumentNote | undefined> {
  // A Reader close/reopen can happen before the lifecycle flush transaction has
  // committed. Wait for the same-key write queue so reopening never reloads a
  // stale value that is about to be replaced.
  await (saveQueues.get(noteId(documentId, pageNumber)) ?? Promise.resolve())
  return idbGet('documentNotes', noteId(documentId, pageNumber))
}

export async function listDocumentNotes(documentId?: string): Promise<DocumentNote[]> {
  const rows = documentId === undefined ? await idbGetAll('documentNotes') : await idbGetAllByIndex('documentNotes', 'by_document', documentId)
  return (rows as DocumentNote[]).sort((a, b) => a.documentId.localeCompare(b.documentId) || a.pageNumber - b.pageNumber)
}

export async function saveDocumentNote(documentId: string, pageNumber: number, content: string): Promise<DocumentNote | undefined> {
  const key = noteId(documentId, pageNumber)
  const prior = saveQueues.get(key) ?? Promise.resolve()
  const result = prior.catch(() => undefined).then(() => idbSaveDocumentNote(documentId, key, pageNumber, content, Date.now())) as Promise<DocumentNote | undefined>
  const tail = result.then(() => undefined, () => undefined)
  saveQueues.set(key, tail)
  void tail.then(() => { if (saveQueues.get(key) === tail) saveQueues.delete(key) })
  return result
}

export async function deleteDocumentNotes(documentId: string): Promise<void> {
  const notes = await listDocumentNotes(documentId)
  for (const note of notes) await idbDelete('documentNotes', note.id)
}
