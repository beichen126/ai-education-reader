import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnnotatedMarkdown } from '../annotations/AnnotatedMarkdown'
import { ArtifactLibrary } from '../artifacts/ArtifactLibrary'
import { ArtifactEditor } from '../artifacts/ArtifactEditor'
import { QuizViewer } from '../artifacts/QuizViewer'
import { isArtifactSourceLive } from '../artifacts/artifact-service'
import { getArtifact } from '../artifacts/artifact-store'
import type { StudyArtifact } from '../artifacts/artifact-types'
import { listDocumentSummaries } from '../documents/document-service'
import { listConversations } from '../storage/storage'
import {
  DEFAULT_STUDY_CARD_SORT, STUDY_CARD_SORT_MODES, buildStudyCardFilterOptions, createStudyCardSeed,
  selectStudyCards, studyCardPlainText, type StudyCardSortMode,
} from './study-card-sorting'
import type { StudyCard, StudyCardDocumentRef, StudyCardFilterKey, StudyCardRating } from './study-card-types'
import {
  deleteStudyCard, getStudyCard, getStudyCardSourceStatus, listStudyCards, markStudyCardOpened,
  openStudyCardSource, updateStudyCardRating, updateStudyCardTitle, type StudyCardSourceStatus,
} from './study-card-service'
import { documentUiActions } from '../documents/document-ui-store'
import { learningUiActions, loadStudyCardPreferences, persistStudyCardPreferences, useLearningUi, type CardListContext } from './learning-ui-store'
import css from './study-card.module.css'
import { localizedConversationTitle, localizedErrorText, localizedPdfName, localizedStudyCardTitle, tx } from '../engine/locale'

const SEARCH_DEBOUNCE_MS = 200
/** The list mounts at most this many rows at once, so a 5000-card library never renders
 *  5000 DOM nodes. Search and filters are the way to reach the rest. */
const LIST_PAGE_SIZE = 200

function formatPages(pages: readonly number[]): string {
  if (pages.length === 0) return ''
  const ranges: string[] = []
  let start = pages[0]
  let end = pages[0]
  for (const page of pages.slice(1)) {
    if (page === end + 1) { end = page; continue }
    ranges.push(start === end ? String(start) : start + '–' + end)
    start = page; end = page
  }
  ranges.push(start === end ? String(start) : start + '–' + end)
  return tx('第 ' + ranges.join('、') + ' 页', 'Pages ' + ranges.join(', '))
}

export function formatDocumentRef(ref: StudyCardDocumentRef): string {
  const relation = ref.relation === 'turn' ? tx('本轮上下文', 'Current turn') : tx('此前上下文', 'Earlier context')
  return localizedPdfName(ref.fileNameSnapshot) + ' · ' + relation + ' · ' + formatPages(ref.pageNumbers)
}

function timestampLabel(value: number | undefined): string {
  return value === undefined ? '' : new Date(value).toLocaleString()
}

function cardTitle(card: StudyCard): string {
  return localizedStudyCardTitle(card.title, card.titleMode, card.autoTitleOrdinal)
}

/**
 * Global learning centre (v2.2.0 §9). Cards and generated artifacts are first-class global
 * objects: the centre never depends on a conversation being open, lists card metadata only,
 * and freezes the ordered id list it opened a card from so prev/next cannot drift.
 */
export function LearningCenter() {
  const state = useLearningUi(s => s)
  const [cards, setCards] = useState<StudyCard[]>([])
  const [documentNames, setDocumentNames] = useState<Map<string, string>>(new Map())
  const [pageCounts, setPageCounts] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Read-only diagnostics computed with the list, never on every render (§11.4). */
  const [diagnostics, setDiagnostics] = useState<{ detached: number; missingDocuments: number } | null>(null)
  const [filter, setFilter] = useState<StudyCardFilterKey>({ kind: 'all' })
  const [sort, setSort] = useState<StudyCardSortMode>(DEFAULT_STUDY_CARD_SORT)
  const [seed, setSeed] = useState(() => createStudyCardSeed())
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [preferencesReady, setPreferencesReady] = useState(false)

  // ---- load once: last explicit filter/sort choice is a preference, not a schema field ----
  useEffect(() => {
    let active = true
    void loadStudyCardPreferences().then(prefs => {
      if (!active) return
      setFilter(previous => (previous.kind === 'all' ? prefs.filter : previous))
      setSort(prefs.sort)
      setPreferencesReady(true)
    })
    return () => { active = false }
  }, [])

  const reload = useCallback(async () => {
    try {
      const [next, documents, conversations] = await Promise.all([
        listStudyCards(),
        listDocumentSummaries().catch(() => []),
        listConversations().catch(() => []),
      ])
      setCards(next)
      setDocumentNames(new Map<string, string>(documents.map(document => [document.id, document.fileName] as [string, string])))
      setPageCounts(new Map<string, number>(documents.map(document => [document.id, document.pageCount] as [string, number])))
      // Detached sources are a property of the data, so they are counted here instead of
      // making the Settings dialog walk every card on every open.
      const conversationIds = new Set(conversations.map(conversation => conversation.id))
      const documentIds = new Set(documents.map(document => document.id))
      setDiagnostics({
        detached: next.filter(card => !conversationIds.has(card.source.conversationId)).length,
        missingDocuments: next.filter(card => card.documentRefs.some(ref => ref.documentId && !documentIds.has(ref.documentId))).length,
      })
      setError(null)
    } catch (e) {
      setError(localizedErrorText(e, 'Failed to load study cards'))
    } finally {
      setLoading(false)
    }
  }, [])
  // The centre is mounted for the whole app lifetime but must read the store every time it
  // is opened: cards can be saved while it is closed.
  const open = state.view !== 'closed'
  useEffect(() => { if (open) void reload() }, [open, reload])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!preferencesReady) return
    void persistStudyCardPreferences({ sort, filter })
  }, [filter, preferencesReady, sort])

  const filterOptions = useMemo(() => buildStudyCardFilterOptions(cards, documentNames), [cards, documentNames])
  const selected = useMemo(() => selectStudyCards(cards, { filter, query: debouncedQuery, sort, seed }), [cards, debouncedQuery, filter, seed, sort])
  const orderedIds = useMemo(() => selected.map(card => card.id), [selected])
  // The frozen prev/next order always covers the WHOLE result set; only the rendered rows
  // are capped, so "下一张" can still walk past the mounted window.
  const [visibleCount, setVisibleCount] = useState(LIST_PAGE_SIZE)
  useEffect(() => { setVisibleCount(LIST_PAGE_SIZE) }, [debouncedQuery, filter, seed, sort])
  const visibleCards = useMemo(() => selected.slice(0, visibleCount), [selected, visibleCount])

  // ---- open / close ----
  const openCard = (cardId: string) => learningUiActions.openCard(cardId, { filter, query: debouncedQuery, sort, seed, orderedIds })

  if (state.view === 'closed') return null

  return (
    <div className={css.overlay} role="presentation" onClick={() => learningUiActions.close()}>
      <div className={css.center} role="dialog" aria-modal="true" aria-label={tx('学习中心', 'Learning center')} data-testid="learning-center" onClick={event => event.stopPropagation()}>
        <div className={css.header}>
          <h2 className={css.title}>{tx('学习中心', 'Learning center')}</h2>
          <div className={css.tabs} role="tablist" aria-label={tx('学习中心分类', 'Learning center sections')}>
            <button type="button" role="tab" className={css.tab} data-testid="learning-tab-cards" aria-selected={state.view === 'library' ? state.tab === 'cards' : state.view === 'card'} onClick={() => learningUiActions.backToLibrary('cards')}>{tx('学习卡片', 'Study cards')}</button>
            <button type="button" role="tab" className={css.tab} data-testid="learning-tab-artifacts" aria-selected={state.view === 'library' ? state.tab === 'artifacts' : state.view === 'artifact'} onClick={() => learningUiActions.backToLibrary('artifacts')}>{tx('学习成果', 'Study outputs')}</button>
          </div>
          <div className={css.spacer} />
          <button type="button" className={css.close} data-testid="learning-center-close" aria-label={tx('关闭学习中心', 'Close learning center')} onClick={() => learningUiActions.close()}>{tx('关闭', 'Close')}</button>
        </div>
        {state.view === 'artifact' ? (
          <ArtifactDetail artifactId={state.artifactId} onBack={() => learningUiActions.closeArtifact()} />
        ) : state.view === 'card' ? (
          <CardDetail
            key={state.cardId}
            cardId={state.cardId}
            context={state.context}
            documentNames={documentNames}
            pageCounts={pageCounts}
            onBack={() => learningUiActions.backToLibrary('cards')}
            onChanged={() => void reload()}
          />
        ) : state.tab === 'artifacts' ? (
          <div className={css.artifactPane}>
            <ArtifactLibrary onOpen={artifact => learningUiActions.openArtifact(artifact.id, 'artifacts')} />
          </div>
        ) : (
          <div className={css.body}>
            <div className={css.listPane}>
              <div className={css.toolbar}>
                <label className={css.field}>{tx('来源', 'Source')}
                  <select className={css.select} data-testid="card-filter" value={filterKeyValue(filter)} onChange={event => setFilter(parseFilterValue(event.target.value))}>
                    {filterOptions.map(option => (
                      <option key={filterKeyValue(option.key)} value={filterKeyValue(option.key)}>{localizedFilterLabel(option.key, option.label)}{tx(`（${option.count}）`, ` (${option.count})`)}</option>
                    ))}
                  </select>
                </label>
                <label className={css.field}>{tx('排序', 'Sort')}
                  <select className={css.select} data-testid="card-sort" value={sort} onChange={event => {
                    const next = event.target.value as StudyCardSortMode
                    setSort(next)
                    // Re-choosing 随机顺序 (or any change) while random is active reseeds.
                    if (next === 'random') setSeed(createStudyCardSeed())
                  }}>
                    {STUDY_CARD_SORT_MODES.map(mode => <option key={mode.id} value={mode.id}>{localizedSortLabel(mode.id, mode.label)}</option>)}
                  </select>
                </label>
                {sort === 'random' && <button type="button" className={css.reroll} data-testid="card-reroll" onClick={() => setSeed(createStudyCardSeed())}>{tx('重新随机', 'Shuffle again')}</button>}
                <input className={css.search} data-testid="card-search" aria-label={tx('搜索学习卡片', 'Search study cards')} placeholder={tx('搜索标题、正文、会话或 PDF', 'Search title, body, chat, or PDF')} value={query} onChange={event => setQuery(event.target.value)} />
              </div>
              {loading && <div className={css.empty} data-testid="card-list-loading">{tx('正在读取学习卡片…', 'Loading study cards…')}</div>}
              {error && <div className={css.error} data-testid="card-list-error" role="alert">{error}</div>}
              {diagnostics && (diagnostics.detached > 0 || diagnostics.missingDocuments > 0) && (
                <div className={css.hint} data-testid="learning-diagnostics">
                  {diagnostics.detached > 0 && <span data-testid="learning-diagnostics-detached">{tx(diagnostics.detached + ' 张卡片的原会话已删除，正文仍可读。', diagnostics.detached + ' cards have deleted source chats; their content remains available.')}</span>}
                  {diagnostics.detached > 0 && diagnostics.missingDocuments > 0 && ' '}
                  {diagnostics.missingDocuments > 0 && <span data-testid="learning-diagnostics-documents">{tx(diagnostics.missingDocuments + ' 张卡片的来源 PDF 已删除，仍可按快照查看。', diagnostics.missingDocuments + ' cards have deleted source PDFs; their snapshots remain available.')}</span>}
                </div>
              )}
              {!loading && !error && selected.length === 0 && (
                <div className={css.empty} data-testid="card-list-empty">
                  {cards.length === 0 ? tx('还没有学习卡片。在 AI 回复的「⋯」菜单里选择「保存本轮回复为学习卡片」。', 'No study cards yet. Open the “⋯” menu on an AI response and choose “Save this response as a study card”.') : tx('没有符合当前筛选条件的学习卡片。', 'No study cards match the current filters.')}
                </div>
              )}
              <ul className={css.list} data-testid="card-list">
                {visibleCards.map(card => (
                  <li key={card.id}>
                    <button type="button" className={css.item} data-testid="card-item" data-card-id={card.id} aria-current={false} onClick={() => openCard(card.id)}>
                      <span className={css.itemTitle} data-testid="card-item-title">{cardTitle(card)}</span>
                      <span className={css.itemSummary}>{studyCardPlainText(card.bodyMarkdown).slice(0, 240)}</span>
                      <span className={css.itemMeta}>
                        {card.rating !== undefined && <span className={css.ratingBadge} data-testid="card-item-rating" aria-label={tx('评分 ' + card.rating + ' 分', 'Rating ' + card.rating + ' out of 5')}>★ {card.rating}/5</span>}
                        {!!card.annotations?.length && <span className={css.ratingBadge} data-testid="card-item-marks">{tx('已标记 ' + card.annotations.length + ' 处', card.annotations.length + ' marks')}</span>}
                        <span data-testid="card-item-conversation">{localizedConversationTitle(card.source.conversationTitleSnapshot) || tx('学习卡片', 'Study card')}</span>
                        {card.documentRefs.length > 0 && <span data-testid="card-item-sources">{card.documentRefs.map(ref => localizedPdfName(ref.fileNameSnapshot)).join(tx('、', ', '))}</span>}
                        <span>{tx('创建 ', 'Created ')}{timestampLabel(card.createdAt)}</span>
                        {card.lastOpenedAt !== undefined && <span>{tx('最近打开 ', 'Last opened ')}{timestampLabel(card.lastOpenedAt)}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {selected.length > visibleCards.length && (
                <div className={css.hint} data-testid="card-list-more">
                  {tx('已显示 ' + visibleCards.length + ' / ' + selected.length + ' 张卡片；用上面的搜索或来源筛选缩小范围。', 'Showing ' + visibleCards.length + ' / ' + selected.length + ' cards. Use search or source filters to narrow the list.')}
                  <button type="button" className={css.reroll} data-testid="card-list-more-button" onClick={() => setVisibleCount(count => count + LIST_PAGE_SIZE)}>{tx('再显示 ' + LIST_PAGE_SIZE + ' 张', 'Show ' + LIST_PAGE_SIZE + ' more')}</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function localizedSortLabel(mode: StudyCardSortMode, fallback: string): string {
  const english: Record<StudyCardSortMode, string> = {
    'created-desc': 'Created (newest first)', 'created-asc': 'Created (oldest first)',
    'updated-desc': 'Recently modified', 'last-opened-desc': 'Recently opened',
    'rating-desc': 'Rating (high to low)', random: 'Random order',
  }
  return tx(fallback, english[mode])
}

function localizedFilterLabel(key: StudyCardFilterKey, fallback: string): string {
  if (key.kind === 'all') return tx(fallback, 'All sources')
  if (key.kind === 'no-pdf') return tx(fallback, 'No PDF source')
  if (key.kind === 'unlocated') return tx(fallback, 'Unlocatable PDF source')
  return tx(fallback, fallback.replace('（已删除）', ' (deleted)'))
}

function filterKeyValue(key: StudyCardFilterKey): string {
  if (key.kind === 'document') return 'document:' + key.documentId
  return key.kind
}

function parseFilterValue(value: string): StudyCardFilterKey {
  if (value.startsWith('document:')) return { kind: 'document', documentId: value.slice('document:'.length) }
  if (value === 'no-pdf') return { kind: 'no-pdf' }
  if (value === 'unlocated') return { kind: 'unlocated' }
  return { kind: 'all' }
}

function CardDetail({ cardId, context, documentNames, pageCounts, onBack, onChanged }: { cardId: string; context: CardListContext; documentNames: Map<string, string>; pageCounts: Map<string, number>; onBack: () => void; onChanged: () => void }) {
  const orderedIds = context.orderedIds
  const [card, setCard] = useState<StudyCard | null>(null)
  const [missing, setMissing] = useState(false)
  const [title, setTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceStatus, setSourceStatus] = useState<StudyCardSourceStatus | null>(null)
  const [clampNote, setClampNote] = useState<string | null>(null)
  const [hoverRating, setHoverRating] = useState<StudyCardRating | null>(null)
  const openedRef = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    void getStudyCard(cardId).then(found => {
      if (!active) return
      setCard(found ?? null)
      setMissing(!found)
      setTitle(found ? cardTitle(found) : '')
      if (found) {
        void getStudyCardSourceStatus(found).then(status => { if (active) setSourceStatus(status) }).catch(() => { if (active) setSourceStatus(null) })
      }
    })
    return () => { active = false }
  }, [cardId])

  /** Open the first real source page; clamp + say so when the document changed. */
  const openSourcePage = (ref: StudyCardDocumentRef, page: number) => {
    if (!ref.documentId || !documentNames.has(ref.documentId)) return
    const total = pageCounts.get(ref.documentId)
    const requested = Math.max(1, Math.trunc(page) || 1)
    const target = total !== undefined ? Math.min(requested, total) : requested
    const clamped = total !== undefined && target !== requested
    documentUiActions.openReader(ref.documentId, target)
    // Normally the centre steps aside so the user lands on the PDF. When the document
    // changed under the card, the centre stays visible long enough to explain the clamp.
    if (clamped) setClampNote(tx('这份 PDF 现在只有 ' + total + ' 页，已定位到第 ' + target + ' 页；卡片快照仍保留原来的页码。', 'This PDF now has ' + total + ' pages. Opened page ' + target + '; the card snapshot keeps the original page number.'))
    else { setClampNote(null); learningUiActions.close() }
  }
  const backToConversation = async () => {
    if (!card) return
    setError(null)
    const opened = await openStudyCardSource(card)
    if (opened) { learningUiActions.close(); return }
    setSourceStatus(await getStudyCardSourceStatus(card))
    setError(tx('原会话或这条回复已删除，无法回链。', 'The source chat or answer was deleted and cannot be opened.'))
  }

  // Opening a card really shown to the user marks lastOpenedAt exactly once per card.
  useEffect(() => {
    if (!card || openedRef.current === card.id) return
    openedRef.current = card.id
    void markStudyCardOpened(card.id, Date.now()).catch(() => undefined)
  }, [card])

  const positions = useMemo(() => orderedIds.length > 0 ? orderedIds : (card ? [card.id] : []), [card, orderedIds])
  const index = card ? positions.indexOf(card.id) : -1
  const previousId = index > 0 ? positions[index - 1] : undefined
  const nextId = index >= 0 && index < positions.length - 1 ? positions[index + 1] : undefined

  const commitRename = async () => {
    if (!card) return
    const clean = title.trim()
    if (!clean || clean === cardTitle(card)) { setRenaming(false); setTitle(cardTitle(card)); return }
    setBusy(true)
    try {
      const updated = await updateStudyCardTitle(card.id, clean, card.updatedAt)
      if (updated) { setCard(updated); setTitle(updated.title); setError(null); onChanged() }
      else setError(tx('卡片已在其它标签页中被修改，未覆盖较新的标题。', 'This card was changed in another tab. The newer title was not overwritten.'))
    } catch (e) {
      setError(localizedErrorText(e, 'Rename failed'))
    } finally { setBusy(false); setRenaming(false) }
  }

  const commitRating = async (rating: StudyCardRating | undefined) => {
    if (!card || busy || card.rating === rating) return
    setBusy(true)
    try {
      const updated = await updateStudyCardRating(card.id, rating, card.updatedAt)
      if (updated) { setCard(updated); setError(null); onChanged() }
      else setError(tx('卡片已在其它标签页中被修改，请重新打开后再评分。', 'This card was changed in another tab. Reopen it before rating.'))
    } catch (e) {
      setError(localizedErrorText(e, 'Unable to save rating'))
    } finally {
      setBusy(false)
      setHoverRating(null)
    }
  }

  const remove = async () => {
    if (!card || !globalThis.confirm(tx('删除这张学习卡片？（不会删除原会话、PDF 或学习成果）', 'Delete this study card? Its source chat, PDF, and study output will not be deleted.'))) return
    setBusy(true)
    try {
      await deleteStudyCard(card.id)
      onChanged()
      const neighbour = nextId ?? previousId
      if (neighbour) learningUiActions.openCard(neighbour, context)
      else onBack()
    } catch (e) {
      setError(localizedErrorText(e, 'Delete failed'))
    } finally { setBusy(false) }
  }

  if (missing) {
    return (
      <div className={css.detail}>
        <div className={css.detailHead}><span className={css.itemTitle}>{tx('这张卡片已被删除', 'This card was deleted')}</span><div className={css.spacer} /><button type="button" className={css.small} data-testid="card-back" onClick={onBack}>{tx('返回列表', 'Back to list')}</button></div>
        <div className={css.empty} data-testid="card-missing">{tx('它可能在另一个标签页里被删除了。', 'It may have been deleted in another tab.')}</div>
      </div>
    )
  }
  if (!card) return <div className={css.empty} data-testid="card-loading">{tx('正在读取卡片…', 'Loading card…')}</div>

  return (
    <div className={css.detail} data-testid="card-viewer" data-card-id={card.id}>
      <div className={css.detailHead}>
        {renaming ? (
          <input
            className={css.titleInput}
            data-testid="card-title-input"
            aria-label={tx('卡片标题', 'Card title')}
            autoFocus
            value={title}
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); void commitRename() }
              else if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); setTitle(cardTitle(card)) }
            }}
            onBlur={() => { if (renaming) void commitRename() }}
          />
        ) : (
          <button type="button" className={css.itemTitle + ' ' + css.titleButton} data-testid="card-title" title={tx('点击重命名', 'Click to rename')} onClick={() => setRenaming(true)}>{cardTitle(card)}</button>
        )}
        <div className={css.spacer} />
        <button type="button" className={css.small} data-testid="card-rename" disabled={busy} onClick={() => setRenaming(true)}>{tx('重命名', 'Rename')}</button>
        <button type="button" className={css.small + ' ' + css.danger} data-testid="card-delete" disabled={busy} onClick={() => void remove()}>{tx('删除', 'Delete')}</button>
      </div>
      <div className={css.ratingRow} data-testid="card-rating">
        <span className={css.ratingLabel}>{tx('给这张卡片评分', 'Rate this card')}</span>
        <span className={css.ratingStars} role="group" aria-label={tx('学习卡片评分', 'Study card rating')} onMouseLeave={() => setHoverRating(null)}>
          {([1, 2, 3, 4, 5] as StudyCardRating[]).map(value => {
            const active = value <= (hoverRating ?? card.rating ?? 0)
            return (
              <button
                key={value}
                type="button"
                className={css.ratingButton}
                data-testid={'card-rating-' + value}
                data-active={active ? 'true' : 'false'}
                aria-label={tx('设置为 ' + value + ' 分', 'Set rating to ' + value)}
                aria-pressed={card.rating === value}
                title={tx(value + ' 分', value + ' stars')}
                disabled={busy}
                onMouseEnter={() => setHoverRating(value)}
                onFocus={() => setHoverRating(value)}
                onBlur={() => setHoverRating(null)}
                onClick={() => void commitRating(value)}
              >★</button>
            )
          })}
        </span>
        <span className={css.ratingValue} data-testid="card-rating-value" aria-live="polite">{card.rating === undefined ? tx('未评分', 'Not rated') : card.rating + ' / 5'}</span>
        {card.rating !== undefined && <button type="button" className={css.ratingClear} data-testid="card-rating-clear" disabled={busy} onClick={() => void commitRating(undefined)}>{tx('清除', 'Clear')}</button>}
      </div>
      <div className={css.detailBody} data-testid="card-detail-body">
        <AnnotatedMarkdown content={card.bodyMarkdown} messageId={card.source.assistantMessageId} conversationId={card.source.conversationId} branchId={card.source.branchId} />
      </div>
      <div className={css.sourceList} data-testid="card-sources">
        <div className={css.sourceRow}>
          <strong>{tx('来源会话', 'Source chat')}</strong>
          <span data-testid="card-source-conversation">{localizedConversationTitle(card.source.conversationTitleSnapshot) || tx('学习卡片', 'Study card')}</span>
          {sourceStatus === 'live' && <button type="button" className={css.small} data-testid="card-back-to-conversation" onClick={() => void backToConversation()}>{tx('返回原会话', 'Open source chat')}</button>}
          {sourceStatus !== null && sourceStatus !== 'live' && (
            <span data-testid="card-source-deleted">
              {sourceStatus === 'conversation-deleted' ? tx('原会话已删除', 'Source chat deleted') : sourceStatus === 'branch-deleted' ? tx('原分支已删除', 'Source branch deleted') : tx('原回复已删除', 'Source answer deleted')}
            </span>
          )}
        </div>
        {card.documentRefs.map((ref, i) => {
          const available = !!ref.documentId && documentNames.has(ref.documentId) && pageCounts.has(ref.documentId as string)
          return (
            <div className={css.sourceRow} key={(ref.documentId ?? 'no-id') + ':' + i} data-testid="card-source-pdf" data-document-id={ref.documentId ?? ''} data-document-missing={String(!available)}>
              <strong>{tx('来源 PDF', 'Source PDF')}</strong>
              <span>{formatDocumentRef(ref)}</span>
              {!available && <span data-testid="card-source-pdf-missing">{tx('（已删除，仅保留快照）', '(deleted; snapshot retained)')}</span>}
              {available && (
                <>
                  <button type="button" className={css.small} data-testid="card-source-pdf-open" onClick={() => openSourcePage(ref, ref.pageNumbers[0])}>
                    {tx('打开第 ' + ref.pageNumbers[0] + ' 页', 'Open page ' + ref.pageNumbers[0])}
                  </button>
                  {ref.pageNumbers.length > 1 && (
                    <span className={css.chips} data-testid="card-source-pdf-pages">
                      {ref.pageNumbers.map(page => (
                        <button key={page} type="button" className={css.chip} data-testid="card-source-pdf-page" data-page={page} onClick={() => openSourcePage(ref, page)}>{tx('第 ' + page + ' 页', 'Page ' + page)}</button>
                      ))}
                    </span>
                  )}
                </>
              )}
            </div>
          )
        })}
        {clampNote && <div className={css.hint} data-testid="card-source-clamp-note">{clampNote}</div>}
        {card.documentRefs.length === 0 && <div className={css.sourceRow} data-testid="card-source-none">{tx('这张卡片没有 PDF 来源。', 'This card has no PDF source.')}</div>}
        <div className={css.sourceRow}><span>{tx('创建 ', 'Created ')}{timestampLabel(card.createdAt)}</span>{card.lastOpenedAt !== undefined && <span>· {tx('最近打开 ', 'Last opened ')}{timestampLabel(card.lastOpenedAt)}</span>}</div>
      </div>
      {error && <div className={css.error} data-testid="card-error" role="alert">{error}</div>}
      <div className={css.detailHead}>
        <button type="button" className={css.small} data-testid="card-prev" disabled={!previousId} onClick={() => previousId && learningUiActions.openCard(previousId, context)}>{tx('上一张', 'Previous')}</button>
        <span className={css.position} data-testid="card-position">{index + 1} / {positions.length}</span>
        <button type="button" className={css.small} data-testid="card-next" disabled={!nextId} onClick={() => nextId && learningUiActions.openCard(nextId, context)}>{tx('下一张', 'Next')}</button>
        <div className={css.spacer} />
        <button type="button" className={css.small} data-testid="card-back" onClick={onBack}>{tx('返回列表', 'Back to list')}</button>
      </div>
    </div>
  )
}

function ArtifactDetail({ artifactId, onBack }: { artifactId: string; onBack: () => void }) {
  const [artifact, setArtifact] = useState<StudyArtifact | null>(null)
  const [live, setLive] = useState(true)
  useEffect(() => {
    let active = true
    void getArtifact(artifactId).then(found => {
      if (!active) return
      setArtifact(found ?? null)
      if (found) void isArtifactSourceLive(found).then(value => { if (active) setLive(value) }).catch(() => { if (active) setLive(false) })
    })
    return () => { active = false }
  }, [artifactId])
  if (!artifact) return <div className={css.empty} data-testid="artifact-missing">{tx('这个学习成果已不存在。', 'This study output no longer exists.')}<button type="button" className={css.small} onClick={onBack}>{tx('返回列表', 'Back to list')}</button></div>
  return (
    <div className={css.artifactPane} data-testid="learning-artifact-detail">
      {artifact.kind === 'quiz' && artifact.quiz && artifact.status === 'ready'
        ? <QuizViewer quiz={artifact.quiz} />
        : <ArtifactEditor artifact={artifact} onOpenArtifact={setArtifact} onClose={onBack} onChanged={() => void getArtifact(artifactId).then(setArtifact)} sourceDeleted={!live} />}
    </div>
  )
}
