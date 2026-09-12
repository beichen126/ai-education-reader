import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownBlocks } from '../markdown/MarkdownBlocks'
import { ArtifactLibrary } from '../artifacts/ArtifactLibrary'
import { ArtifactEditor } from '../artifacts/ArtifactEditor'
import { QuizViewer } from '../artifacts/QuizViewer'
import { isArtifactSourceLive } from '../artifacts/artifact-service'
import { getArtifact } from '../artifacts/artifact-store'
import type { StudyArtifact } from '../artifacts/artifact-types'
import { listDocumentSummaries } from '../documents/document-service'
import {
  DEFAULT_STUDY_CARD_SORT, STUDY_CARD_SORT_MODES, buildStudyCardFilterOptions, createStudyCardSeed,
  selectStudyCards, studyCardPlainText, type StudyCardSortMode,
} from './study-card-sorting'
import type { StudyCard, StudyCardDocumentRef, StudyCardFilterKey } from './study-card-types'
import {
  deleteStudyCard, getStudyCard, getStudyCardSourceStatus, listStudyCards, markStudyCardOpened,
  openStudyCardSource, updateStudyCardTitle, type StudyCardSourceStatus,
} from './study-card-service'
import { documentUiActions } from '../documents/document-ui-store'
import { learningUiActions, loadStudyCardPreferences, persistStudyCardPreferences, useLearningUi, type CardListContext } from './learning-ui-store'
import css from './study-card.module.css'

const SEARCH_DEBOUNCE_MS = 200

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
  return '第 ' + ranges.join('、') + ' 页'
}

export function formatDocumentRef(ref: StudyCardDocumentRef): string {
  const relation = ref.relation === 'turn' ? '本轮上下文' : '此前上下文'
  return ref.fileNameSnapshot + ' · ' + relation + ' · ' + formatPages(ref.pageNumbers)
}

function timestampLabel(value: number | undefined): string {
  return value === undefined ? '' : new Date(value).toLocaleString()
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
      const [next, documents] = await Promise.all([listStudyCards(), listDocumentSummaries().catch(() => [])])
      setCards(next)
      setDocumentNames(new Map<string, string>(documents.map(document => [document.id, document.fileName] as [string, string])))
      setPageCounts(new Map<string, number>(documents.map(document => [document.id, document.pageCount] as [string, number])))
      setError(null)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '学习卡片读取失败')
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

  // ---- open / close ----
  const openCard = (cardId: string) => learningUiActions.openCard(cardId, { filter, query: debouncedQuery, sort, seed, orderedIds })

  if (state.view === 'closed') return null

  return (
    <div className={css.overlay} role="presentation" onClick={() => learningUiActions.close()}>
      <div className={css.center} role="dialog" aria-modal="true" aria-label="学习中心" data-testid="learning-center" onClick={event => event.stopPropagation()}>
        <div className={css.header}>
          <h2 className={css.title}>学习中心</h2>
          <div className={css.tabs} role="tablist" aria-label="学习中心分类">
            <button type="button" role="tab" className={css.tab} data-testid="learning-tab-cards" aria-selected={state.view === 'library' ? state.tab === 'cards' : state.view === 'card'} onClick={() => learningUiActions.backToLibrary('cards')}>学习卡片</button>
            <button type="button" role="tab" className={css.tab} data-testid="learning-tab-artifacts" aria-selected={state.view === 'library' ? state.tab === 'artifacts' : state.view === 'artifact'} onClick={() => learningUiActions.backToLibrary('artifacts')}>学习成果</button>
          </div>
          <div className={css.spacer} />
          <button type="button" className={css.close} data-testid="learning-center-close" aria-label="关闭学习中心" onClick={() => learningUiActions.close()}>关闭</button>
        </div>
        {state.view === 'artifact' ? (
          <ArtifactDetail artifactId={state.artifactId} onBack={() => learningUiActions.closeArtifact()} />
        ) : state.view === 'card' ? (
          <CardDetail
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
                <label className={css.field}>来源
                  <select className={css.select} data-testid="card-filter" value={filterKeyValue(filter)} onChange={event => setFilter(parseFilterValue(event.target.value))}>
                    {filterOptions.map(option => (
                      <option key={filterKeyValue(option.key)} value={filterKeyValue(option.key)}>{option.label}（{option.count}）</option>
                    ))}
                  </select>
                </label>
                <label className={css.field}>排序
                  <select className={css.select} data-testid="card-sort" value={sort} onChange={event => {
                    const next = event.target.value as StudyCardSortMode
                    setSort(next)
                    // Re-choosing 随机顺序 (or any change) while random is active reseeds.
                    if (next === 'random') setSeed(createStudyCardSeed())
                  }}>
                    {STUDY_CARD_SORT_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
                  </select>
                </label>
                {sort === 'random' && <button type="button" className={css.reroll} data-testid="card-reroll" onClick={() => setSeed(createStudyCardSeed())}>重新随机</button>}
                <input className={css.search} data-testid="card-search" aria-label="搜索学习卡片" placeholder="搜索标题、正文、会话或 PDF" value={query} onChange={event => setQuery(event.target.value)} />
              </div>
              {loading && <div className={css.empty} data-testid="card-list-loading">正在读取学习卡片…</div>}
              {error && <div className={css.error} data-testid="card-list-error" role="alert">{error}</div>}
              {!loading && !error && selected.length === 0 && (
                <div className={css.empty} data-testid="card-list-empty">
                  {cards.length === 0 ? '还没有学习卡片。在 AI 回复的「⋯」菜单里选择「保存本轮回复为学习卡片」。' : '没有符合当前筛选条件的学习卡片。'}
                </div>
              )}
              <ul className={css.list} data-testid="card-list">
                {selected.map(card => (
                  <li key={card.id}>
                    <button type="button" className={css.item} data-testid="card-item" data-card-id={card.id} aria-current={false} onClick={() => openCard(card.id)}>
                      <span className={css.itemTitle} data-testid="card-item-title">{card.title}</span>
                      <span className={css.itemSummary}>{studyCardPlainText(card.bodyMarkdown).slice(0, 240)}</span>
                      <span className={css.itemMeta}>
                        <span data-testid="card-item-conversation">{card.source.conversationTitleSnapshot || '学习卡片'}</span>
                        {card.documentRefs.length > 0 && <span data-testid="card-item-sources">{card.documentRefs.map(ref => ref.fileNameSnapshot).join('、')}</span>}
                        <span>创建 {timestampLabel(card.createdAt)}</span>
                        {card.lastOpenedAt !== undefined && <span>最近打开 {timestampLabel(card.lastOpenedAt)}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  )
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
  const openedRef = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    void getStudyCard(cardId).then(found => {
      if (!active) return
      setCard(found ?? null)
      setMissing(!found)
      setTitle(found?.title ?? '')
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
    if (clamped) setClampNote('这份 PDF 现在只有 ' + total + ' 页，已定位到第 ' + target + ' 页；卡片快照仍保留原来的页码。')
    else { setClampNote(null); learningUiActions.close() }
  }
  const backToConversation = async () => {
    if (!card) return
    setError(null)
    const opened = await openStudyCardSource(card)
    if (opened) { learningUiActions.close(); return }
    setSourceStatus(await getStudyCardSourceStatus(card))
    setError('原会话或这条回复已删除，无法回链。')
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
    if (!clean || clean === card.title) { setRenaming(false); setTitle(card.title); return }
    setBusy(true)
    try {
      const updated = await updateStudyCardTitle(card.id, clean, card.updatedAt)
      if (updated) { setCard(updated); setTitle(updated.title); setError(null); onChanged() }
      else setError('卡片已在其它标签页中被修改，未覆盖较新的标题。')
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '重命名失败')
    } finally { setBusy(false); setRenaming(false) }
  }

  const remove = async () => {
    if (!card || !globalThis.confirm('删除这张学习卡片？（不会删除原会话、PDF 或学习成果）')) return
    setBusy(true)
    try {
      await deleteStudyCard(card.id)
      onChanged()
      const neighbour = nextId ?? previousId
      if (neighbour) learningUiActions.openCard(neighbour, context)
      else onBack()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '删除失败')
    } finally { setBusy(false) }
  }

  if (missing) {
    return (
      <div className={css.detail}>
        <div className={css.detailHead}><span className={css.itemTitle}>这张卡片已被删除</span><div className={css.spacer} /><button type="button" className={css.small} data-testid="card-back" onClick={onBack}>返回列表</button></div>
        <div className={css.empty} data-testid="card-missing">它可能在另一个标签页里被删除了。</div>
      </div>
    )
  }
  if (!card) return <div className={css.empty} data-testid="card-loading">正在读取卡片…</div>

  return (
    <div className={css.detail} data-testid="card-viewer" data-card-id={card.id}>
      <div className={css.detailHead}>
        {renaming ? (
          <input
            className={css.titleInput}
            data-testid="card-title-input"
            aria-label="卡片标题"
            autoFocus
            value={title}
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); void commitRename() }
              else if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); setTitle(card.title) }
            }}
            onBlur={() => { if (renaming) void commitRename() }}
          />
        ) : (
          <button type="button" className={css.itemTitle} data-testid="card-title" title="点击重命名" onClick={() => setRenaming(true)}>{card.title}</button>
        )}
        <div className={css.spacer} />
        <button type="button" className={css.small} data-testid="card-rename" disabled={busy} onClick={() => setRenaming(true)}>重命名</button>
        <button type="button" className={css.small + ' ' + css.danger} data-testid="card-delete" disabled={busy} onClick={() => void remove()}>删除</button>
      </div>
      <div className={css.detailBody}>
        <MarkdownBlocks content={card.bodyMarkdown} messageId={'study-card-' + card.id} />
      </div>
      <div className={css.sourceList} data-testid="card-sources">
        <div className={css.sourceRow}>
          <strong>来源会话</strong>
          <span data-testid="card-source-conversation">{card.source.conversationTitleSnapshot || '学习卡片'}</span>
          {sourceStatus === 'live' && <button type="button" className={css.small} data-testid="card-back-to-conversation" onClick={() => void backToConversation()}>返回原会话</button>}
          {sourceStatus !== null && sourceStatus !== 'live' && (
            <span data-testid="card-source-deleted">
              {sourceStatus === 'conversation-deleted' ? '原会话已删除' : sourceStatus === 'branch-deleted' ? '原分支已删除' : '原回复已删除'}
            </span>
          )}
        </div>
        {card.documentRefs.map((ref, i) => {
          const available = !!ref.documentId && documentNames.has(ref.documentId) && pageCounts.has(ref.documentId as string)
          return (
            <div className={css.sourceRow} key={(ref.documentId ?? 'no-id') + ':' + i} data-testid="card-source-pdf" data-document-id={ref.documentId ?? ''} data-document-missing={String(!available)}>
              <strong>来源 PDF</strong>
              <span>{formatDocumentRef(ref)}</span>
              {!available && <span data-testid="card-source-pdf-missing">（已删除，仅保留快照）</span>}
              {available && (
                <>
                  <button type="button" className={css.small} data-testid="card-source-pdf-open" onClick={() => openSourcePage(ref, ref.pageNumbers[0])}>
                    打开第 {ref.pageNumbers[0]} 页
                  </button>
                  {ref.pageNumbers.length > 1 && (
                    <span className={css.chips} data-testid="card-source-pdf-pages">
                      {ref.pageNumbers.map(page => (
                        <button key={page} type="button" className={css.chip} data-testid="card-source-pdf-page" data-page={page} onClick={() => openSourcePage(ref, page)}>第 {page} 页</button>
                      ))}
                    </span>
                  )}
                </>
              )}
            </div>
          )
        })}
        {clampNote && <div className={css.hint} data-testid="card-source-clamp-note">{clampNote}</div>}
        {card.documentRefs.length === 0 && <div className={css.sourceRow} data-testid="card-source-none">这张卡片没有 PDF 来源。</div>}
        <div className={css.sourceRow}><span>创建 {timestampLabel(card.createdAt)}</span>{card.lastOpenedAt !== undefined && <span>· 最近打开 {timestampLabel(card.lastOpenedAt)}</span>}</div>
      </div>
      {error && <div className={css.error} data-testid="card-error" role="alert">{error}</div>}
      <div className={css.detailHead}>
        <button type="button" className={css.small} data-testid="card-prev" disabled={!previousId} onClick={() => previousId && learningUiActions.openCard(previousId, context)}>上一张</button>
        <span className={css.position} data-testid="card-position">{index + 1} / {positions.length}</span>
        <button type="button" className={css.small} data-testid="card-next" disabled={!nextId} onClick={() => nextId && learningUiActions.openCard(nextId, context)}>下一张</button>
        <div className={css.spacer} />
        <button type="button" className={css.small} data-testid="card-back" onClick={onBack}>返回列表</button>
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
  if (!artifact) return <div className={css.empty} data-testid="artifact-missing">这个学习成果已不存在。<button type="button" className={css.small} onClick={onBack}>返回列表</button></div>
  return (
    <div className={css.artifactPane} data-testid="learning-artifact-detail">
      {artifact.kind === 'quiz' && artifact.quiz && artifact.status === 'ready'
        ? <QuizViewer quiz={artifact.quiz} />
        : <ArtifactEditor artifact={artifact} onOpenArtifact={setArtifact} onClose={onBack} onChanged={() => void getArtifact(artifactId).then(setArtifact)} sourceDeleted={!live} />}
    </div>
  )
}
