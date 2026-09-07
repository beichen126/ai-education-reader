

import { useEffect, useMemo, useRef, useState } from 'react'
import { listDocumentSummaries, getDocumentContextDescriptor, setDocumentBookmarkRangePreferences, type DocumentContextDescriptor, type DocumentSummary, type BookmarkRangePreferenceUpdate } from './document-service'
import { buildChapterNodesSelection, findChapterById, selectableChapterRange } from './document-context'
import { normalizePdfRanges, countPdfRangePages, pdfRangesText, needsPdfContextSoftConfirm, exceedsPdfContextHardLimit, validatePdfRange, MAX_PDF_CONTEXT_PAGES, type PdfRange, type PdfSelection } from '../pdf/pdf-types'
import type { ChapterNode } from './document-types'
import { bookmarkRangeEndModeOf } from './bookmark-range-preferences'
import { bookmarkRangePresentation, type BookmarkRangeEndMode } from '../pdf/bookmark-range'
import css from './document-context-picker.module.css'

type Props = {
  documentId?: string
  onCancel: () => void
  onAdd: (selection: PdfSelection, documentId: string, fileName: string) => void
}

type PreferenceKeyState = {
  confirmed: BookmarkRangeEndMode
  desired: BookmarkRangeEndMode
  generation: number
  pending: Promise<void> | null
  error: string | null
}

type PreferenceWriteEntry = {
  documentId: string
  updates: BookmarkRangePreferenceUpdate[]
  generations: Map<string, number>
  chain: Promise<void>
}

// One consistent mental model: 选择范围 -> 查看汇总 -> 加入当前对话.
// Stage model (blocker 0.1): unscoped picker shows the document list first; a scoped picker
// (Library / Reader) goes straight to the context stage and never offers a misleading back.
// Back semantics (0.10): only the unscoped picker has a document-list back; a scoped picker
// has no back that would clear the document and leave an empty panel.
export function DocumentContextPicker({ documentId, onCancel, onAdd }: Props) {
  const scoped = !!documentId
  const [stage, setStage] = useState<'document' | 'context'>(scoped ? 'context' : 'document')
  const [doc, setDoc] = useState<DocumentContextDescriptor | null>(null)
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'toc' | 'manual'>('toc')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [wholeChecked, setWholeChecked] = useState(false)
  const [manualSel, setManualSel] = useState<PdfSelection | null>(null)
  const [blockMsg, setBlockMsg] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<PdfSelection | null>(null)
  const preferenceStatesRef = useRef(new Map<string, PreferenceKeyState>())
  const preferenceQueuesRef = useRef(new Map<string, Promise<void>>())
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  // Load the document list only for the unscoped (document) stage.
  useEffect(() => { if (stage === 'document' && !scoped) { void listDocumentSummaries().then(setDocs).catch(() => setDocs([])) } }, [stage, scoped])
  // Load the descriptor when scoped (already have a doc id) OR after a doc is picked.
  useEffect(() => {
    const id = scoped ? documentId : (doc ? doc.id : null)
    if (!id) return
    void getDocumentContextDescriptor(id).then(d => { setDoc(d); if (!d) setBlockMsg('这份文档不存在或已被删除。') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, documentId, stage])

  const selectDoc = async (id: string) => {
    const d = await getDocumentContextDescriptor(id)
    if (!d) { setBlockMsg('这份文档不存在或已被删除。'); return }
    setDoc(d); setBlockMsg(null)
    // Unscoped: transition to the context stage (blocker 0.1).
    setStage('context')
  }

  // Back from context stage -> document list (unscoped only).
  const backToDocs = () => {
    setDoc(null); setChecked(new Set()); setWholeChecked(false); setManualSel(null)
    setTab('toc'); setManualStart(''); setManualEnd(''); setManualError(null)
    setStage('document')
  }

  const filtered = useMemo(() => {
    if (!docs) return []
    const q = search.trim().toLowerCase()
    return q ? docs.filter(d => d.fileName.toLowerCase().includes(q)) : docs
  }, [docs, search])

  const toggle = (id: string) => {
    // Selecting a TOC chapter switches the scope to TOC (clears whole / manual).
    setWholeChecked(false); setManualSel(null)
    setChecked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  const sameLevelSelectableChapterIds = (chapterId: string): string[] => {
    if (!doc) return []
    const target = findChapterById(doc.chapters, chapterId)
    if (!target) return []
    const ids: string[] = []
    const walk = (nodes: ChapterNode[]) => {
      for (const node of nodes) {
        if (node.level === target.level && selectableChapterRange(node)) ids.push(node.id)
        walk(node.children)
      }
    }
    walk(doc.chapters)
    return ids
  }

  const preferenceKey = (documentId: string, chapterId: string) => documentId + ':' + chapterId

  const ensurePreferenceState = (targetDoc: DocumentContextDescriptor, chapterId: string): PreferenceKeyState => {
    const key = preferenceKey(targetDoc.id, chapterId)
    const existing = preferenceStatesRef.current.get(key)
    if (existing) return existing
    const mode = bookmarkRangeEndModeOf(targetDoc.bookmarkRangePreferences, chapterId)
    const created: PreferenceKeyState = { confirmed: mode, desired: mode, generation: 0, pending: null, error: null }
    preferenceStatesRef.current.set(key, created)
    return created
  }

  const applyPreferenceRollback = (documentId: string, entry: PreferenceWriteEntry) => {
    if (!mountedRef.current) return
    setDoc(current => {
      if (!current || current.id !== documentId) return current
      const restored = { ...(current.bookmarkRangePreferences ?? {}) }
      for (const update of entry.updates) {
        const key = preferenceKey(documentId, update.chapterId)
        const state = preferenceStatesRef.current.get(key)
        if (!state || state.generation !== entry.generations.get(key)) continue
        restored[update.chapterId] = state.desired
      }
      return Object.keys(restored).length > 0 ? { ...current, bookmarkRangePreferences: restored } : { ...current, bookmarkRangePreferences: undefined }
    })
  }

  const enqueuePreferenceWrite = (targetDoc: DocumentContextDescriptor, updates: BookmarkRangePreferenceUpdate[]) => {
    const generations = new Map<string, number>()
    for (const update of updates) {
      const state = ensurePreferenceState(targetDoc, update.chapterId)
      state.desired = update.endMode
      state.error = null
      state.generation += 1
      generations.set(preferenceKey(targetDoc.id, update.chapterId), state.generation)
    }
    const previous = preferenceQueuesRef.current.get(targetDoc.id) ?? Promise.resolve()
    const chain = previous.catch(() => {}).then(() => setDocumentBookmarkRangePreferences(targetDoc.id, updates))
    const entry: PreferenceWriteEntry = { documentId: targetDoc.id, updates, generations, chain }
    for (const update of updates) ensurePreferenceState(targetDoc, update.chapterId).pending = chain
    preferenceQueuesRef.current.set(targetDoc.id, chain)
    void chain.then(() => {
      for (const update of entry.updates) {
        const key = preferenceKey(entry.documentId, update.chapterId)
        const state = preferenceStatesRef.current.get(key)
        if (!state) continue
        state.confirmed = update.endMode
        if (state.generation === entry.generations.get(key)) { state.pending = null; state.error = null }
      }
    }).catch(() => {
      let currentFailure = false
      for (const update of entry.updates) {
        const key = preferenceKey(entry.documentId, update.chapterId)
        const state = preferenceStatesRef.current.get(key)
        if (!state || state.generation !== entry.generations.get(key)) continue
        state.desired = state.confirmed
        state.pending = null
        state.error = '范围语义保存失败，请重试。'
        currentFailure = true
      }
      if (currentFailure) {
        applyPreferenceRollback(entry.documentId, entry)
        if (mountedRef.current) setBlockMsg('范围语义保存失败，请重试。')
      }
    }).finally(() => {
      if (preferenceQueuesRef.current.get(entry.documentId) === entry.chain) preferenceQueuesRef.current.delete(entry.documentId)
    })
  }

  const flushPreferenceWrites = async (documentId?: string): Promise<boolean> => {
    if (!documentId) return true
    while (true) {
      const pending = preferenceQueuesRef.current.get(documentId)
      if (!pending) break
      await pending.catch(() => {})
    }
    return !Array.from(preferenceStatesRef.current.entries()).some(([key, state]) => key.startsWith(documentId + ':') && state.error !== null)
  }

  const changeBookmarkRangeMode = (chapterId: string, endMode: BookmarkRangeEndMode) => {
    if (!doc) return
    const targetDoc = doc
    const ids = sameLevelSelectableChapterIds(chapterId)
    const updates = (ids.length > 0 ? ids : [chapterId]).map(id => ({ chapterId: id, endMode }))
    setBlockMsg(null)
    setDoc(current => {
      if (!current || current.id !== targetDoc.id) return current
      const preferences = { ...(current.bookmarkRangePreferences ?? {}) }
      for (const update of updates) preferences[update.chapterId] = update.endMode
      return { ...current, bookmarkRangePreferences: preferences }
    })
    enqueuePreferenceWrite(targetDoc, updates)
  }

  // Selected chapter nodes (in TOC order) from the checked set.
  const selectedNodes = useMemo(() => {
    if (!doc) return []
    const out: ChapterNode[] = []
    const walk = (list: ChapterNode[]) => { for (const n of list) { if (checked.has(n.id) && selectableChapterRange(n)) out.push(n); walk(n.children) } }
    walk(doc.chapters)
    return out
  }, [doc, checked])

  // ONE reviewed selection. Scope precedence: whole > manual > toc > none.
  const selection: PdfSelection = useMemo(() => {
    if (wholeChecked && doc) return { kind: 'manual', title: doc.fileName, ranges: [{ startPage: 1, endPage: doc.pageCount }] }
    if (manualSel) return manualSel
    if (selectedNodes.length) return buildChapterNodesSelection(selectedNodes, { pageCount: doc?.pageCount, bookmarkRangePreferences: doc?.bookmarkRangePreferences })
    return { kind: 'manual', ranges: [] }
  }, [wholeChecked, manualSel, selectedNodes, doc])
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  const selectionCount = countPdfRangePages(selection.ranges)
  const wholeCount = doc ? countPdfRangePages([{ startPage: 1, endPage: doc.pageCount }]) : 0
  const wholeBlocked = doc ? exceedsPdfContextHardLimit(doc.pageCount) : false
  const hasScope = wholeChecked || selectedNodes.length > 0 || !!manualSel

  const addWhole = () => {
    if (!doc || wholeBlocked) return
    setWholeChecked(true); setChecked(new Set()); setManualSel(null); setTab('toc')
  }
  const addManual = () => {
    if (!doc) return
    const v = validatePdfRange(manualStart, manualEnd, doc.pageCount)
    if (v) { setManualError(v); return }
    setManualError(null)
    const s = Number(manualStart.trim()), e = Number(manualEnd.trim())
    setWholeChecked(false); setChecked(new Set())
    setManualSel({ kind: 'manual', title: pdfRangesText([{ startPage: s, endPage: e }]), ranges: [{ startPage: s, endPage: e }] })
  }

  const requestCancel = async () => {
    if (await flushPreferenceWrites(doc?.id)) onCancel()
  }

  const requestBackToDocs = async () => {
    if (await flushPreferenceWrites(doc?.id)) backToDocs()
  }

  const commit = async () => {
    if (!(await flushPreferenceWrites(doc?.id))) return
    const currentSelection = selectionRef.current
    if (currentSelection.ranges.length === 0) { setBlockMsg('请先选择要加入的章节或页码范围。'); return }
    const count = countPdfRangePages(currentSelection.ranges)
    if (exceedsPdfContextHardLimit(count)) { setBlockMsg('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页，请缩小章节或页码范围。'); return }
    if (needsPdfContextSoftConfirm(count)) { setConfirming(currentSelection); return }
    finishAdd(currentSelection)
  }
  const finishAdd = (sel: PdfSelection) => { if (doc) onAdd(sel, doc.id, doc.fileName) }

  return (
    <div className={css.overlay} data-testid="doc-context-picker">
      <div className={css.panel}>
        <div className={css.header}>
          {stage === 'context' && !scoped && (
            <button type="button" className={css.back} data-testid="doc-context-back" onClick={() => void requestBackToDocs()}>←</button>
          )}
          <span className={css.title}>{stage === 'document' ? '从文件资料库加入对话' : (doc ? doc.fileName : '')}</span>
          <span className={css.subTitle}>{stage === 'context' && doc ? doc.pageCount + ' 页' : ''}</span>
          <button type="button" className={css.btn} data-testid="doc-context-cancel" onClick={() => void requestCancel()}>取消</button>
        </div>
        {stage === 'document' ? (
          <div className={css.docPick}>
            <input className={css.search} data-testid="doc-context-search" placeholder="搜索文件" value={search} onChange={e => setSearch(e.target.value)} />
            <div className={css.docList} data-testid="doc-context-doclist">
              {(filtered || []).map(d => (
                <button key={d.id} type="button" className={css.docRow} data-testid={'doc-context-doc-' + d.id} onClick={() => void selectDoc(d.id)}>
                  <div className={css.docName}>{d.fileName}</div>
                  <div className={css.docMeta}>PDF · {d.pageCount} 页 · {d.chapterCount > 0 ? '有目录' : '无目录'}</div>
                </button>
              ))}
              {docs && docs.length === 0 && <div className={css.empty}>还没有本地文件，请先导入 PDF。</div>}
            </div>
          </div>
        ) : doc ? (
          <>
            <div className={css.tabs}>
              <button type="button" className={css.tab + (tab === 'toc' ? ' ' + css.tabOn : '')} data-testid="doc-context-tab-toc" onClick={() => { setTab('toc'); setWholeChecked(false); setManualSel(null) }}>目录</button>
              <button type="button" className={css.tab + (tab === 'manual' ? ' ' + css.tabOn : '')} data-testid="doc-context-tab-manual" onClick={() => { setTab('manual'); setWholeChecked(false) }}>页码</button>
            </div>
            {tab === 'toc' ? (
              <div className={css.body} data-testid="doc-context-tree">
                <button type="button" className={css.whole + (wholeChecked ? ' ' + css.wholeOn : '')} data-testid="doc-context-whole" disabled={wholeBlocked} onClick={addWhole}>
                  <span>整份文档 · {doc.pageCount} 页</span>
                </button>
                {wholeBlocked && <div className={css.limitHint}>当前一次最多处理 120 页，请选择章节或页码范围。</div>}
                {doc.chapters.length === 0 ? (
                  <div className={css.empty}>这份文档还没有目录。可使用「页码」或「整份文档」（&le;120 页）。</div>
                ) : (
                  <ChapterTreeCheck nodes={doc.chapters} checked={checked} bookmarkRangePreferences={doc.bookmarkRangePreferences} pageCount={doc.pageCount} onToggle={toggle} onModeChange={changeBookmarkRangeMode} />
                )}
              </div>
            ) : (
              <div className={css.manualBody} data-testid="doc-context-manual">
                <div className={css.fieldRow}><label>开始页</label><input className={css.input} data-testid="doc-context-ms" inputMode="numeric" value={manualStart} onChange={e => setManualStart(e.target.value)} /></div>
                <div className={css.fieldRow}><label>结束页</label><input className={css.input} data-testid="doc-context-me" inputMode="numeric" value={manualEnd} onChange={e => setManualEnd(e.target.value)} /></div>
                {manualError && <div className={css.limitHint} data-testid="doc-context-manual-error">{manualError}</div>}
                <button type="button" className={css.btn} data-testid="doc-context-manual-add" onClick={addManual}>选择范围</button>
              </div>
            )}
            <div className={css.footer}>
              <div className={css.summary} data-testid="doc-context-summary">
                {hasScope ? (
                  <>{selection.title ? '已选择：' + selection.title : '已选择：' + (wholeChecked ? '整份文档' : pdfRangesText(selection.ranges))}<br />{pdfRangesText(selection.ranges)} · 共 {selectionCount} 页</>
                ) : (
                  <>已选择：未选择章节</>
                )}
              </div>
              <div className={css.footerBtns}>
                <button type="button" className={css.btn} data-testid="doc-context-cancel2" onClick={() => void requestCancel()}>取消</button>
                <button type="button" className={css.btnPrimary} data-testid="doc-context-add" onClick={() => void commit()}>加入当前对话</button>
              </div>
            </div>
          </>
        ) : null}
        {confirming && (
          <div className={css.confirm} data-testid="doc-context-confirm">
            <div>本次将加入 {countPdfRangePages(confirming.ranges)} 页内容，处理时间和模型输入都会比较大。确认继续？</div>
            <div className={css.confirmBtns}>
              <button className={css.btnPrimary} data-testid="doc-context-confirm-yes" onClick={() => { const s = confirming; setConfirming(null); finishAdd(s) }}>继续加入</button>
              <button className={css.btn} data-testid="doc-context-confirm-no" onClick={() => setConfirming(null)}>取消</button>
            </div>
          </div>
        )}
        {blockMsg && <div className={css.blockMsg} data-testid="doc-context-block">{blockMsg}</div>}
      </div>
    </div>
  )
}

function ChapterTreeCheck({ nodes, checked, pageCount, bookmarkRangePreferences, onToggle, onModeChange }: { nodes: ChapterNode[]; checked: Set<string>; pageCount: number; bookmarkRangePreferences?: Record<string, BookmarkRangeEndMode>; onToggle: (id: string) => void; onModeChange: (id: string, mode: BookmarkRangeEndMode) => void }) {
  return (
    <div className={css.tree}>
      {nodes.map(n => {
        const range = selectableChapterRange(n)
        const disabled = !range
        const mode = bookmarkRangeEndModeOf(bookmarkRangePreferences, n.id)
        const presentation = range ? bookmarkRangePresentation({ startPage: range.startPage, endPage: range.endPage, pageCount }) : null
        return (
          <div key={n.id}>
            <div className={css.treeRow} data-depth={n.level} data-testid={'doc-context-node-' + n.id} style={{ paddingLeft: (Math.max(n.level, 1) - 1) * 16 + 4 }}>
              <label className={css.treeChoice}>
                <input type="checkbox" data-testid={'doc-context-check-' + n.id} checked={checked.has(n.id)} disabled={disabled} onChange={() => onToggle(n.id)} />
                <span className={css.treeTitle} title={n.title}>{n.title}</span>
              </label>
              {presentation ? (
                <span className={css.treeDetails}>
                  <span className={css.treeRange} data-testid={'doc-context-actual-' + n.id}>{presentation[mode].label}</span>
                  <select className={css.rangeMode} data-testid={'doc-context-mode-' + n.id} aria-label={n.title + ' 范围语义'} value={mode} onChange={e => onModeChange(n.id, e.target.value as BookmarkRangeEndMode)}>
                    <option value="exclusive">左闭右开 {presentation.exclusive.label}</option>
                    <option value="inclusive">左闭右闭 {presentation.inclusive.label}</option>
                  </select>
                </span>
              ) : <span className={css.treeRange}>无法定位页码</span>}
            </div>
            {n.children.length > 0 && <ChapterTreeCheck nodes={n.children} checked={checked} pageCount={pageCount} bookmarkRangePreferences={bookmarkRangePreferences} onToggle={onToggle} onModeChange={onModeChange} />}
          </div>
        )
      })}
    </div>
  )
}
