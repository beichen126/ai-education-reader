import { useSyncExternalStore } from 'react'
import { getSetting, setSetting } from '../storage/storage'
import { DEFAULT_STUDY_CARD_SORT, type StudyCardFilterKey, type StudyCardSortMode } from './study-card-sorting'
import type { StudyCardPreferences } from './study-card-types'

/**
 * Global learning-centre UI state (v2.2.0 §9.1). It is deliberately NOT part of the
 * gallery/document/session stores: the learning centre is independent of whether a
 * conversation is currently open.
 */

/** The list context captured when a card was opened. Prev/next walks exactly this list. */
export type CardListContext = {
  filter: StudyCardFilterKey
  query: string
  sort: StudyCardSortMode
  seed: number
  orderedIds: string[]
}

export type LearningUiState =
  | { view: 'closed' }
  | { view: 'library'; tab: 'cards' | 'artifacts' }
  | { view: 'card'; cardId: string; context: CardListContext }
  | { view: 'artifact'; artifactId: string; returnTab: 'cards' | 'artifacts' }

let state: LearningUiState = { view: 'closed' }
let lastTab: 'cards' | 'artifacts' = 'cards'
const subs = new Set<() => void>()
function notify() { subs.forEach(fn => fn()) }
function set(next: LearningUiState) { state = next; notify() }

export const learningUiActions = {
  openLibrary(tab: 'cards' | 'artifacts' = 'cards') { lastTab = tab; set({ view: 'library', tab }); notify() },
  close() { set({ view: 'closed' }) },
  backToLibrary(tab?: 'cards' | 'artifacts') { const next = tab ?? lastTab; lastTab = next; set({ view: 'library', tab: next }) },
  openCard(cardId: string, context: CardListContext) { set({ view: 'card', cardId, context }) },
  openArtifact(artifactId: string, returnTab: 'cards' | 'artifacts' = 'artifacts') { set({ view: 'artifact', artifactId, returnTab }) },
  closeArtifact() { set({ view: 'library', tab: lastTab }) },
}

export function getLearningUiSnapshot(): LearningUiState { return state }

export function useLearningUi<T>(select: (state: LearningUiState) => T): T {
  return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => select(state))
}

const PREFERENCES_KEY = 'studyCardPreferences'

/** Restore the last explicit filter/sort choice. Unknown or legacy values are dropped. */
export async function loadStudyCardPreferences(): Promise<{ sort: StudyCardSortMode; filter: StudyCardFilterKey }> {
  let stored: StudyCardPreferences | undefined
  try { stored = (await getSetting(PREFERENCES_KEY)) as StudyCardPreferences | undefined } catch { stored = undefined }
  const sorts: StudyCardSortMode[] = ['created-desc', 'created-asc', 'updated-desc', 'last-opened-desc', 'random']
  const sort = stored && stored.sort && sorts.includes(stored.sort) ? stored.sort : DEFAULT_STUDY_CARD_SORT
  const filter = normalizeFilterKey(stored?.documentFilter) ?? { kind: 'all' }
  return { sort, filter }
}

export async function persistStudyCardPreferences(next: { sort: StudyCardSortMode; filter: StudyCardFilterKey }): Promise<void> {
  try { await setSetting(PREFERENCES_KEY, { sort: next.sort, documentFilter: next.filter }) } catch { /* a preference is rebuildable: best effort */ }
}

export function normalizeFilterKey(value: unknown): StudyCardFilterKey | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { kind?: unknown; documentId?: unknown }
  if (raw.kind === 'all') return { kind: 'all' }
  if (raw.kind === 'no-pdf') return { kind: 'no-pdf' }
  if (raw.kind === 'unlocated') return { kind: 'unlocated' }
  if (raw.kind === 'document' && typeof raw.documentId === 'string' && raw.documentId) return { kind: 'document', documentId: raw.documentId }
  return undefined
}
