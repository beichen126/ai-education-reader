import { idbDelete, idbGet, idbGetAll, idbGetAllByIndex, idbPut } from '../storage/idb'
import type { DocumentNote } from './document-types'
export type { DocumentNote } from './document-types'

function noteId(documentId: string, pageNumber: number): string {
  return documentId + '/page-' + pageNumber
}

export async function getDocumentNote(documentId: string, pageNumber: number): Promise<DocumentNote | undefined> {
  return idbGet('documentNotes', noteId(documentId, pageNumber))
}

export async function listDocumentNotes(documentId?: string): Promise<DocumentNote[]> {
  const rows = documentId === undefined ? await idbGetAll('documentNotes') : await idbGetAllByIndex('documentNotes', 'by_document', documentId)
  return (rows as DocumentNote[]).sort((a, b) => a.documentId.localeCompare(b.documentId) || a.pageNumber - b.pageNumber)
}

export async function saveDocumentNote(documentId: string, pageNumber: number, content: string): Promise<DocumentNote | undefined> {
  const clean = content
  const existing = await getDocumentNote(documentId, pageNumber)
  if (!clean.trim()) {
    if (existing) await idbDelete('documentNotes', existing.id)
    return undefined
  }
  const now = Date.now()
  const next: DocumentNote = {
    id: existing?.id ?? noteId(documentId, pageNumber),
    documentId,
    pageNumber,
    content: clean,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await idbPut('documentNotes', next)
  return next
}

export async function deleteDocumentNotes(documentId: string): Promise<void> {
  const notes = await listDocumentNotes(documentId)
  for (const note of notes) await idbDelete('documentNotes', note.id)
}
