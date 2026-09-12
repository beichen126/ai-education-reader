import type { StudyCard, StudyCardFilterKey, StudyCardListSort } from './study-card-types'

export type { StudyCardFilterKey } from './study-card-types'

/**
 * Card list ordering, filtering and search (v2.2.0 §1.5 / §9.3 / §9.4 / §9.6).
 *
 * Pure domain: the learning centre keeps the *frozen* ordered id list it opened a card
 * from, so `lastOpenedAt` updates can never reshuffle the list under the user, and
 * prev/next keeps walking the list the user actually saw.
 */

export type StudyCardSortMode = StudyCardListSort

export const STUDY_CARD_SORT_MODES: { id: StudyCardSortMode; label: string }[] = [
  { id: 'created-desc', label: '创建时间（新→旧）' },
  { id: 'created-asc', label: '创建时间（旧→新）' },
  { id: 'updated-desc', label: '最近修改' },
  { id: 'last-opened-desc', label: '最近打开' },
  { id: 'random', label: '随机顺序' },
]

export const DEFAULT_STUDY_CARD_SORT: StudyCardSortMode = 'created-desc'

export type StudyCardFilterOption = {
  key: StudyCardFilterKey
  label: string
  count: number
  /** True when the referenced document no longer exists locally. */
  documentMissing: boolean
}

export function sameStudyCardFilter(a: StudyCardFilterKey, b: StudyCardFilterKey): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'document' && b.kind === 'document') return a.documentId === b.documentId
  return true
}

export function matchesStudyCardFilter(card: StudyCard, key: StudyCardFilterKey): boolean {
  switch (key.kind) {
    case 'all': return true
    case 'no-pdf': return card.documentRefs.length === 0
    case 'unlocated': return card.documentRefs.length > 0 && card.documentRefs.every(ref => !ref.documentId)
    case 'document': return card.documentRefs.some(ref => ref.documentId === key.documentId)
  }
}

/**
 * Options come from the cards themselves plus the file names that still resolve, so a
 * deleted source keeps its snapshot label and is visibly marked as missing.
 */
export function buildStudyCardFilterOptions(cards: readonly StudyCard[], documentNames: ReadonlyMap<string, string>): StudyCardFilterOption[] {
  const options: StudyCardFilterOption[] = [{ key: { kind: 'all' }, label: '全部来源', count: cards.length, documentMissing: false }]
  let noPdf = 0
  let unlocated = 0
  const byDocument = new Map<string, { count: number; fileName: string }>()
  for (const card of cards) {
    if (card.documentRefs.length === 0) { noPdf++; continue }
    const withId = card.documentRefs.filter(ref => !!ref.documentId)
    if (withId.length === 0) { unlocated++; continue }
    for (const ref of withId) {
      const documentId = ref.documentId as string
      const current = byDocument.get(documentId)
      if (current) current.count++
      else byDocument.set(documentId, { count: 1, fileName: ref.fileNameSnapshot })
    }
  }
  if (noPdf > 0) options.push({ key: { kind: 'no-pdf' }, label: '无 PDF 来源', count: noPdf, documentMissing: false })
  for (const [documentId, info] of [...byDocument.entries()].sort((a, b) => (a[1].fileName < b[1].fileName ? -1 : a[1].fileName > b[1].fileName ? 1 : 0))) {
    const live = documentNames.get(documentId)
    options.push({
      key: { kind: 'document', documentId },
      label: live ?? info.fileName + '（已删除）',
      count: info.count,
      documentMissing: !live,
    })
  }
  if (unlocated > 0) options.push({ key: { kind: 'unlocated' }, label: '无法定位的 PDF 来源', count: unlocated, documentMissing: false })
  return options
}

/** Plain-text summary used by the list and by search: never renders full Markdown. */
export function studyCardPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function studyCardSearchText(card: StudyCard): string {
  const files = card.documentRefs.map(ref => ref.fileNameSnapshot).join(' ')
  return [card.title, studyCardPlainText(card.bodyMarkdown), card.source.conversationTitleSnapshot, files].join(' \u0000 ').toLocaleLowerCase()
}

export function matchesStudyCardQuery(card: StudyCard, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return studyCardSearchText(card).includes(needle)
}

/** A fresh shuffle seed. Only produced when the user asks for a new random order. */
export function createStudyCardSeed(): number {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buffer = new Uint32Array(1)
    cryptoObj.getRandomValues(buffer)
    return buffer[0] || 1
  }
  return (Date.now() % 2147483647) || 1
}

/** Deterministic Fisher-Yates with a seeded PRNG (mulberry32). */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = (seed >>> 0) || 1
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let index = out.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1))
    const value = out[index]
    out[index] = out[swap]
    out[swap] = value
  }
  return out
}

function byId(a: StudyCard, b: StudyCard): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }

export function sortStudyCards(cards: readonly StudyCard[], mode: StudyCardSortMode, seed: number): StudyCard[] {
  const list = [...cards]
  switch (mode) {
    case 'created-desc': return list.sort((a, b) => b.createdAt - a.createdAt || byId(a, b))
    case 'created-asc': return list.sort((a, b) => a.createdAt - b.createdAt || byId(a, b))
    case 'updated-desc': return list.sort((a, b) => b.updatedAt - a.updatedAt || byId(a, b))
    case 'last-opened-desc':
      // Never-opened cards come after opened ones instead of pretending to be oldest.
      return list.sort((a, b) => {
        const aOpened = a.lastOpenedAt
        const bOpened = b.lastOpenedAt
        if (aOpened === undefined && bOpened === undefined) return b.createdAt - a.createdAt || byId(a, b)
        if (aOpened === undefined) return 1
        if (bOpened === undefined) return -1
        return bOpened - aOpened || byId(a, b)
      })
    case 'random': return shuffleWithSeed(list.sort(byId), seed)
  }
}

export type StudyCardListQuery = {
  filter: StudyCardFilterKey
  query: string
  sort: StudyCardSortMode
  seed: number
}

/** Filter -> search -> sort. The caller freezes the resulting ids for the opened detail. */
export function selectStudyCards(cards: readonly StudyCard[], listQuery: StudyCardListQuery): StudyCard[] {
  const filtered = cards.filter(card => matchesStudyCardFilter(card, listQuery.filter) && matchesStudyCardQuery(card, listQuery.query))
  return sortStudyCards(filtered, listQuery.sort, listQuery.seed)
}
