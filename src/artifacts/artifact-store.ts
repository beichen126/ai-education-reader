import { idbGet, idbGetAll, idbGetAllByIndex, idbPut, idbDelete, idbBatchPut, idbBatchDelete } from '../storage/idb'
import type { StableId } from '../engine/types'
import type { ArtifactKind, StudyArtifact } from './artifact-types'

/** Study Artifact persistence: first-class 'artifacts' store. */

export async function getArtifact(id: StableId): Promise<StudyArtifact | undefined> {
  return idbGet('artifacts', id)
}

export async function saveArtifact(artifact: StudyArtifact): Promise<void> { await idbPut('artifacts', artifact) }
export async function saveArtifacts(artifacts: StudyArtifact[]): Promise<void> { await idbBatchPut('artifacts', artifacts) }
export async function deleteArtifact(id: StableId): Promise<void> { await idbDelete('artifacts', id) }
export async function deleteArtifacts(ids: StableId[]): Promise<void> { await idbBatchDelete('artifacts', ids) }

/** All artifacts, newest first. List views use this (never hydrate bodies separately). */
export async function listArtifacts(): Promise<StudyArtifact[]> {
  const all = await idbGetAll('artifacts')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listArtifactsByKind(kind: ArtifactKind): Promise<StudyArtifact[]> {
  return idbGetAllByIndex('artifacts', 'by_kind', kind)
}

export async function listArtifactsBySourceConversation(conversationId: StableId): Promise<StudyArtifact[]> {
  return idbGetAllByIndex('artifacts', 'by_source_conversation', conversationId)
}
