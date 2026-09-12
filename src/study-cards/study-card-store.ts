import { idbGetAllByIndex, idbScan, idbTxnDone, openIdb, STORES } from '../storage/idb'
import { validateStudyCard } from './study-card-validation'
import { studyCardPageRefId, type StudyCard, type StudyCardPageRef } from './study-card-types'

/**
 * Row-level StudyCard persistence.
 *
 * Every write keeps the card row and its derived page-ref rows consistent inside ONE
 * readwrite transaction, and resolves only after that transaction COMMITS. The derived
 * rows are never authoritative: they can always be rebuilt from the cards.
 */

/** Rows that failed validation are skipped so one corrupt card cannot break the library;
 *  the count stays observable for diagnostics instead of being silently swallowed. */
let skippedInvalidRows = 0
export function studyCardReadDiagnostics(): { skippedInvalidRows: number } { return { skippedInvalidRows } }

function toCard(row: unknown): StudyCard | undefined {
  try {
    return validateStudyCard(row)
  } catch {
    skippedInvalidRows++
    return undefined
  }
}

function pageRefRowsFor(card: StudyCard): StudyCardPageRef[] {
  const rows: StudyCardPageRef[] = []
  for (const ref of card.documentRefs) {
    if (!ref.documentId) continue
    for (const pageNumber of ref.pageNumbers) {
      rows.push({ id: studyCardPageRefId(ref.documentId, pageNumber, card.id), documentId: ref.documentId, pageNumber, cardId: card.id })
    }
  }
  return rows
}

export async function getStudyCard(id: string): Promise<StudyCard | undefined> {
  const db = await openIdb()
  const row = await new Promise<any>((resolve, reject) => {
    const request = db.transaction('studyCards', 'readonly').objectStore('studyCards').get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return row === undefined ? undefined : toCard(row)
}

export async function getStudyCardBySourceMessage(assistantMessageId: string): Promise<StudyCard | undefined> {
  const rows = await idbGetAllByIndex('studyCards', 'by_source_message', assistantMessageId)
  for (const row of rows as unknown[]) {
    const card = toCard(row)
    if (card) return card
  }
  return undefined
}

export async function listStudyCards(): Promise<StudyCard[]> {
  const cards: StudyCard[] = []
  await idbScan('studyCards', row => { const card = toCard(row); if (card) cards.push(card) })
  return cards
}

export async function listStudyCardsByDocument(documentId: string): Promise<StudyCard[]> {
  const rows = await idbGetAllByIndex('studyCards', 'by_document', documentId)
  return (rows as unknown[]).map(toCard).filter((card): card is StudyCard => !!card)
}

export async function listStudyCardPageRefs(documentId: string): Promise<StudyCardPageRef[]> {
  const rows = await idbGetAllByIndex('studyCardPageRefs', 'by_document', documentId)
  return (rows as StudyCardPageRef[]).filter(row => !!row && typeof row.pageNumber === 'number')
}

/** Cards that really cite this page. Uses the derived composite index, never a scan. */
export async function listStudyCardsByDocumentPage(documentId: string, pageNumber: number): Promise<StudyCard[]> {
  const rows = await idbGetAllByIndex('studyCardPageRefs', 'by_document_page', [documentId, pageNumber])
  const cards: StudyCard[] = []
  const seen = new Set<string>()
  for (const row of rows as StudyCardPageRef[]) {
    if (!row || seen.has(row.cardId)) continue
    seen.add(row.cardId)
    const card = await getStudyCard(row.cardId)
    if (card) cards.push(card)
  }
  return cards
}

export async function countStudyCards(): Promise<number> {
  const db = await openIdb()
  return new Promise<number>((resolve, reject) => {
    const request = db.transaction('studyCards', 'readonly').objectStore('studyCards').count()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Card text size for the storage diagnostics panel (metadata only, no full bodies kept). */
export async function estimateStudyCardTextBytes(): Promise<{ count: number; bodyBytes: number; titleBytes: number }> {
  let count = 0
  let bodyBytes = 0
  let titleBytes = 0
  await idbScan('studyCards', row => {
    const card = toCard(row)
    if (!card) return
    count++
    bodyBytes += card.bodyMarkdown.length * 2
    titleBytes += card.title.length * 2
  })
  return { count, bodyBytes, titleBytes }
}

/** Atomic read-modify-write of one card plus its derived rows. The updater may return
 *  undefined to veto the write (stale revision, invalid input). */
export async function updateStudyCardRow(id: string, updater: (current: StudyCard) => StudyCard | undefined): Promise<StudyCard | undefined> {
  const db = await openIdb()
  let committed: StudyCard | undefined
  let vetoed = false
  await new Promise<void>((resolve, reject) => {
    const txn = db.transaction(['studyCards', 'studyCardPageRefs'], 'readwrite')
    const cards = txn.objectStore('studyCards')
    const refs = txn.objectStore('studyCardPageRefs')
    const request = cards.get(id)
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      try { txn.abort() } catch { /* already aborting */ }
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    request.onsuccess = () => {
      const current = request.result === undefined ? undefined : toCard(request.result)
      if (!current) { vetoed = true; try { txn.abort() } catch { /* ignore */ } return }
      let next: StudyCard | undefined
      try { next = updater(current) } catch (error) { fail(error); return }
      if (!next) { vetoed = true; try { txn.abort() } catch { /* ignore */ } return }
      let validated: StudyCard
      try { validated = validateStudyCard(next) } catch (error) { fail(error); return }
      cards.put(validated)
      const cursor = refs.index('by_card').openCursor(IDBKeyRange.only(id))
      cursor.onsuccess = () => {
        const entry = cursor.result
        if (entry) { refs.delete(entry.primaryKey); entry.continue(); return }
        for (const row of pageRefRowsFor(validated)) refs.put(row)
      }
      committed = validated
    }
    request.onerror = () => fail(request.error)
    txn.oncomplete = () => { if (!settled) { settled = true; resolve() } }
    txn.onerror = () => fail(txn.error)
    txn.onabort = () => { if (!settled) { settled = true; resolve() } }
  })
  if (vetoed) return undefined
  return committed
}

/** Insert a brand new card (create path). The caller guarantees the unique source message. */
export async function insertStudyCardRow(card: StudyCard): Promise<StudyCard> {
  const validated = validateStudyCard(card)
  const db = await openIdb()
  await new Promise<void>((resolve, reject) => {
    const txn = db.transaction(['studyCards', 'studyCardPageRefs'], 'readwrite')
    txn.objectStore('studyCards').put(validated)
    for (const row of pageRefRowsFor(validated)) txn.objectStore('studyCardPageRefs').put(row)
    idbTxnDone(txn).then(resolve, reject)
  })
  return validated
}

export async function deleteStudyCardRow(id: string): Promise<void> {
  const db = await openIdb()
  await new Promise<void>((resolve, reject) => {
    const txn = db.transaction(['studyCards', 'studyCardPageRefs'], 'readwrite')
    txn.objectStore('studyCards').delete(id)
    const store = txn.objectStore('studyCardPageRefs')
    const cursor = store.index('by_card').openCursor(IDBKeyRange.only(id))
    cursor.onsuccess = () => {
      const entry = cursor.result
      if (entry) { store.delete(entry.primaryKey); entry.continue() }
    }
    idbTxnDone(txn).then(resolve, reject)
  })
}

/** Rebuild the derived page index from the authoritative cards. Used after a backup
 *  import so a foreign file can never inject page rows of its own. */
export async function rebuildStudyCardPageRefs(): Promise<number> {
  const db = await openIdb()
  const cards: StudyCard[] = []
  await idbScan('studyCards', row => { const card = toCard(row); if (card) cards.push(card) })
  const rows: StudyCardPageRef[] = cards.flatMap(pageRefRowsFor)
  await new Promise<void>((resolve, reject) => {
    const txn = db.transaction('studyCardPageRefs', 'readwrite')
    const store = txn.objectStore('studyCardPageRefs')
    store.clear()
    for (const row of rows) store.put(row)
    idbTxnDone(txn).then(resolve, reject)
  })
  return rows.length
}

/** Every store name the card writes touch; kept here so callers cannot forget one. */
export const STUDY_CARD_STORES: readonly string[] = STORES.filter(name => name === 'studyCards' || name === 'studyCardPageRefs')
