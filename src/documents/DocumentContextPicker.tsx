

import { PdfContextMode } from './PdfOcrControls'
import { useEffect, useMemo, useRef, useState } from 'react'
import { listDocumentSummaries, getDocument, getDocumentContextDescriptor, documentBinaryExists, setDocumentBookmarkRangePreferences, DocumentBinaryMissingError, type DocumentContextDescriptor, type DocumentSummary, type BookmarkRangePreferenceUpdate } from './document-service'
import { buildChapterNodesSelection, findChapterById, selectableChapterRange } from './document-context'
import type { BookmarkRangePreferenceDelta } from './reader-context'
import { normalizePdfRanges, countPdfRangePages, pdfRangesText, needsPdfContextSoftConfirm, exceedsPdfContextHardLimit, validatePdfRange, MAX_PDF_CONTEXT_PAGES, type PdfRange, type PdfSelection } from '../pdf/pdf-types'
import type { ChapterNode, LearningDocument } from './document-types'
import { bookmarkRangeEndModeOf } from './bookmark-range-preferences'
import { bookmarkRangePresentation, type BookmarkRangeEndMode } from '../pdf/bookmark-range'
import { ChapterRangeModeControl } from './ChapterRangeModeControl'
import { DocumentContextPreview } from './DocumentContextPreview'
import { PdfAttachmentPagePicker } from './PdfAttachmentPagePicker'
import css from './document-context-picker.module.css'
import { tx } from '../engine/locale'
import { useBackTarget } from '../engine/back-navigation'
import { useDialogFocus } from '../engine/use-dialog-focus'

type Props = {
  documentId?: string
  projectName?: string
  onImportPdf?: () => void
  onCancel: () => void
  onAdd: (selection: PdfSelection, documentId: string, fileName: string) => void | Promise<string | undefined>
  onPreferencesCommitted?: (delta: BookmarkRangePreferenceDelta) => void
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
export function DocumentContextPicker({ documentId, projectName, onImportPdf, onCancel, onAdd, onPreferencesCommitted }: Props) {
  const [contextMode, setContextMode] = useState<'image' | 'ocr'>('image')
  const scoped = !!documentId
  const [stage, setStage] = useState<'document' | 'context'>(scoped ? 'context' : 'document')
  const [doc, setDoc] = useState<DocumentContextDescriptor | null>(null)
  const [binaryAvailable, setBinaryAvailable] = useState<boolean | null>(null)
  const [previewDoc, setPreviewDoc] = useState<LearningDocument | null>(null)
  const [visualPages, setVisualPages] = useState(false)
  const [previewInitialPage, setPreviewInitialPage] = useState(1)
  const [previewError, setPreviewError] = useState<string | null>(null)
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
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const [preferenceBusyKeys, setPreferenceBusyKeys] = useState<Set<string>>(new Set())
  const preferenceStatesRef = useRef(new Map<string, PreferenceKeyState>())
  const preferenceQueuesRef = useRef(new Map<string, Promise<void>>())
  const mountedRef = useRef(true)
  const contextBodyRef = useRef<HTMLDivElement | null>(null)
  const previewFocusTargetRef = useRef<string | null>(null)
  const previewScrollTopRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Load the document list only for the unscoped (document) stage.
  useEffect(() => { if (stage === 'document' && !scoped) { void listDocumentSummaries().then(setDocs).catch(() => setDocs([])) } }, [stage, scoped])
  // Load the descriptor when scoped (already have a doc id) OR after a doc is picked.
  useEffect(() => {
    const id = scoped ? documentId : (doc ? doc.id : null)
    if (!id) return
    void getDocumentContextDescriptor(id).then(d => { setDoc(d); if (!d) setBlockMsg(tx('这份文档不存在或已被删除。', 'This document does not exist or was deleted.')) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, documentId, stage])

  useEffect(() => {
    if (!doc) { setBinaryAvailable(null); return }
    let active = true
    setBinaryAvailable(null)
    void documentBinaryExists(doc.id).then(exists => { if (active) setBinaryAvailable(exists) }).catch(() => { if (active) setBinaryAvailable(false) })
    return () => { active = false }
  }, [doc?.id])

  const selectDoc = async (id: string) => {
    const d = await getDocumentContextDescriptor(id)
    if (!d) { setBlockMsg(tx('这份文档不存在或已被删除。', 'This document does not exist or was deleted.')); return }
    setDoc(d); setBlockMsg(null)
    // Unscoped: transition to the context stage (blocker 0.1).
    setStage('context')
  }

  // Back from context stage -> document list (unscoped only).
  const backToDocs = () => {
    setDoc(null); setChecked(new Set()); setWholeChecked(false); setManualSel(null)
    setTab('toc'); setManualStart(''); setManualEnd(''); setManualError(null)
    setBinaryAvailable(null); setPreviewError(null)
    setStage('document')
  }

  const filtered = useMemo(() => {
    if (!docs) return []
    const q = search.trim().toLowerCase()
    return q ? docs.filter(d => d.fileName.toLowerCase().includes(q)) : docs
  }, [docs, search])

  const toggle = (id: string) => {
    if (savingRef.current) return
    setConfirming(null)
    setWholeChecked(false)
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
    setPreferenceBusyKeys(previousKeys => {
      const next = new Set(previousKeys)
      for (const update of updates) next.add(preferenceKey(targetDoc.id, update.chapterId))
      return next
    })
    preferenceQueuesRef.current.set(targetDoc.id, chain)
    void chain.then(() => {
      let currentGeneration = true
      for (const update of entry.updates) {
        const key = preferenceKey(entry.documentId, update.chapterId)
        const state = preferenceStatesRef.current.get(key)
        if (!state) continue
        state.confirmed = update.endMode
        if (state.generation === entry.generations.get(key)) { state.pending = null; state.error = null }
        else currentGeneration = false
      }
      if (currentGeneration && mountedRef.current) onPreferencesCommitted?.({ documentId: entry.documentId, updates: entry.updates })
    }).catch(() => {
      let currentFailure = false
      for (const update of entry.updates) {
        const key = preferenceKey(entry.documentId, update.chapterId)
        const state = preferenceStatesRef.current.get(key)
        if (!state || state.generation !== entry.generations.get(key)) continue
        state.desired = state.confirmed
        state.pending = null
        state.error = tx('范围语义保存失败，请重试。', 'Unable to save range semantics. Try again.')
        currentFailure = true
      }
      if (currentFailure) {
        applyPreferenceRollback(entry.documentId, entry)
        if (mountedRef.current) setBlockMsg(tx('范围语义保存失败，请重试。', 'Unable to save range semantics. Try again.'))
      }
    }).finally(() => {
      if (preferenceQueuesRef.current.get(entry.documentId) === entry.chain) preferenceQueuesRef.current.delete(entry.documentId)
      setPreferenceBusyKeys(previousKeys => {
        const next = new Set(previousKeys)
        for (const update of entry.updates) {
          const key = preferenceKey(entry.documentId, update.chapterId)
          if (!preferenceStatesRef.current.get(key)?.pending) next.delete(key)
        }
        return next
      })
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
    if (tab === 'manual') return manualSel ?? { kind: 'manual', ranges: [] }
    if (wholeChecked && doc) return { kind: 'manual', title: doc.fileName, ranges: [{ startPage: 1, endPage: doc.pageCount }] }
    if (selectedNodes.length) return buildChapterNodesSelection(selectedNodes, { pageCount: doc?.pageCount, bookmarkRangePreferences: doc?.bookmarkRangePreferences })
    return { kind: 'manual', ranges: [] }
  }, [tab, wholeChecked, manualSel, selectedNodes, doc])
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  const selectionCount = countPdfRangePages(selection.ranges)
  const wholeCount = doc ? countPdfRangePages([{ startPage: 1, endPage: doc.pageCount }]) : 0
  const wholeBlocked = doc ? exceedsPdfContextHardLimit(doc.pageCount) : false
  const hasScope = selectionCount > 0

  const addWhole = () => {
    if (!doc || wholeBlocked || savingRef.current) return
    setConfirming(null)
    setWholeChecked(true); setChecked(new Set()); setTab('toc')
  }
  const addManual = () => {
    if (!doc || savingRef.current) return
    setConfirming(null)
    const v = validatePdfRange(manualStart, manualEnd, doc.pageCount)
    if (v) { setManualError(v); return }
    setManualError(null)
    const s = Number(manualStart.trim()), e = Number(manualEnd.trim())
    setManualSel({ kind: 'manual', title: pdfRangesText([{ startPage: s, endPage: e }]), ranges: [{ startPage: s, endPage: e }] })
  }

  const changeManual = (setter: (value: string) => void, value: string) => {
    setter(value)
    setManualSel(null)
    setManualError(null)
    setConfirming(null)
    setBlockMsg(null)
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
    if (currentSelection.ranges.length === 0) { setBlockMsg(tx('请先选择要加入的章节或页码范围。', 'Select chapters or a page range first.')); return }
    const count = countPdfRangePages(currentSelection.ranges)
    if (exceedsPdfContextHardLimit(count)) { setBlockMsg(tx('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页，请缩小章节或页码范围。', 'You can process up to ' + MAX_PDF_CONTEXT_PAGES + ' pages at a time. Reduce the chapter or page range.')); return }
    if (needsPdfContextSoftConfirm(count)) { setConfirming(currentSelection); return }
    await finishAdd(currentSelection)
  }
  const finishAdd = async (sel: PdfSelection) => {
    if (!doc || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setBlockMsg(null)
    const failure = tx('未存入项目', 'PDF pages were not saved to the project')
    try {
      const error = await onAdd({ ...sel, contextMode: projectName === undefined ? contextMode : 'ocr' }, doc.id, doc.fileName)
      if (error && mountedRef.current) setBlockMsg(projectName === undefined ? error : failure + ' · ' + error)
    } catch {
      if (mountedRef.current) setBlockMsg(projectName === undefined ? tx('未加入提问草稿。', 'Could not add to the draft.') : failure)
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  const returnFromPreview = () => {
    setPreviewDoc(null)
    window.requestAnimationFrame(() => {
      if (contextBodyRef.current) contextBodyRef.current.scrollTop = previewScrollTopRef.current
      const target = previewFocusTargetRef.current
      if (target) document.querySelector<HTMLElement>('[data-testid="' + target + '"]')?.focus()
    })
  }

  const openPreview = async () => {
    if (!doc || binaryAvailable !== true) return
    previewFocusTargetRef.current = (document.activeElement as HTMLElement | null)?.dataset.testid || 'doc-context-preview'
    previewScrollTopRef.current = contextBodyRef.current?.scrollTop ?? 0
    setPreviewError(null)
    try {
      const loaded = await getDocument(doc.id)
      if (!loaded || loaded.sourceBlob.size === 0) throw new DocumentBinaryMissingError(doc.id)
      const ranges = normalizePdfRanges(selectionRef.current.ranges)
      const requested = ranges[0]?.startPage ?? loaded.lastReadPage ?? 1
      setPreviewInitialPage(Math.max(1, Math.min(loaded.pageCount, requested)))
      setPreviewDoc(loaded)
    } catch (e) {
      setPreviewError(e instanceof DocumentBinaryMissingError ? tx('本地 PDF 数据不可用，请重新导入。', 'The local PDF data is unavailable. Import it again.') : tx('无法打开该 PDF 预览，请重试。', 'Unable to open this PDF preview. Try again.'))
    }
  }

  const back = () => {
    if (savingRef.current) return
    if (previewDoc) returnFromPreview()
    else if (confirming) setConfirming(null)
    else if (stage === 'context' && !scoped) void requestBackToDocs()
    else void requestCancel()
  }
  useBackTarget(projectName !== undefined, back, 60)
  useDialogFocus(panelRef, !previewDoc && !visualPages, back)

  if (previewDoc) return <DocumentContextPreview document={previewDoc} initialPage={previewInitialPage} onBack={returnFromPreview} />

  const documentListTitle = projectName === undefined
    ? tx('从文件资料库加入对话', 'Add from the file library')
    : tx('从资料库选择 PDF', 'Choose a PDF from the library')
  return (
    <div className={css.overlay} data-testid="doc-context-picker">
      <div className={css.panel} ref={panelRef} role="dialog" aria-modal="true" aria-label={documentListTitle} tabIndex={-1}>
        <div className={css.header}>
          {stage === 'context' && !scoped && (
            <button type="button" className={css.back} data-testid="doc-context-back" disabled={saving} aria-label={tx('返回资料库', 'Back to library')} onClick={() => void requestBackToDocs()}>←</button>
          )}
          <span className={css.title}>{stage === 'document' ? documentListTitle : doc?.fileName}</span>
          <span className={css.subTitle}>{stage === 'context' && doc ? tx(doc.pageCount + ' 页', doc.pageCount + ' pages') : ''}</span>
          <button type="button" className={css.btn} data-testid="doc-context-cancel" disabled={saving} onClick={() => void requestCancel()}>{tx('取消', 'Cancel')}</button>
        </div>
        {stage === 'document' ? (
          <div className={css.docPick}>
            <div className={css.docPickActions}>
              <input className={css.search} data-testid="doc-context-search" placeholder={tx('搜索文件', 'Search files')} value={search} onChange={e => setSearch(e.target.value)} />
              {onImportPdf && <button type="button" className={css.btn} data-testid="doc-context-import-pdf" onClick={onImportPdf}>{tx('导入 PDF', 'Import PDF')}</button>}
            </div>
            <div className={css.docList} data-testid="doc-context-doclist">
              {(filtered || []).map(d => (
                <button key={d.id} type="button" className={css.docRow} data-testid={'doc-context-doc-' + d.id} onClick={() => void selectDoc(d.id)}>
                  <div className={css.docName}>{d.fileName}</div>
                  <div className={css.docMeta}>PDF · {tx(d.pageCount + ' 页', d.pageCount + ' pages')} · {d.chapterCount > 0 ? tx('有目录', 'Has outline') : tx('无目录', 'No outline')}</div>
                </button>
              ))}
              {docs && docs.length === 0 && <div className={css.empty}>{tx('还没有本地文件，请先导入 PDF。', 'No local files yet. Import a PDF first.')}</div>}
            </div>
          </div>
        ) : doc ? (
          <>
            <div className={css.tabs}>
              <button type="button" className={css.tab + (tab === 'toc' ? ' ' + css.tabOn : '')} data-testid="doc-context-tab-toc" disabled={saving} onClick={() => { setTab('toc'); setConfirming(null) }}>{tx('目录', 'Outline')}</button>
              <button type="button" className={css.tab + (tab === 'manual' ? ' ' + css.tabOn : '')} data-testid="doc-context-tab-manual" disabled={saving} onClick={() => { setTab('manual'); setConfirming(null) }}>{tx('页码', 'Pages')}</button>
            </div>
            {tab === 'toc' ? (
              <div ref={contextBodyRef} className={css.body} data-testid="doc-context-tree">
                <button type="button" className={css.whole + (wholeChecked ? ' ' + css.wholeOn : '')} data-testid="doc-context-whole" disabled={wholeBlocked} onClick={addWhole}>
                  <span>{tx('整份文档 · ' + doc.pageCount + ' 页', 'Entire document · ' + doc.pageCount + ' pages')}</span>
                </button>
                {wholeBlocked && <div className={css.limitHint}>{tx('当前一次最多处理 120 页，请选择章节或页码范围。', 'You can process up to 120 pages at a time. Select chapters or a page range.')}</div>}
                {doc.chapters.length === 0 ? (
                  <div className={css.empty}>{tx('这份文档还没有目录。可使用「页码」或「整份文档」（≤120 页）。', 'This document has no outline. Use “Pages” or “Entire document” (up to 120 pages).')}</div>
                ) : (
                  <ChapterTreeCheck nodes={doc.chapters} checked={checked} bookmarkRangePreferences={doc.bookmarkRangePreferences} pageCount={doc.pageCount} preferenceBusy={chapterId => preferenceBusyKeys.has(preferenceKey(doc.id, chapterId))} onToggle={toggle} onModeChange={changeBookmarkRangeMode} />
                )}
              </div>
            ) : (
              <div ref={contextBodyRef} className={css.manualBody} data-testid="doc-context-manual">
                <button type="button" className={css.btn} data-testid="doc-context-visual-pages" disabled={saving || binaryAvailable !== true} onClick={() => { setConfirming(null); setVisualPages(true) }}>{tx('按缩略图选页', 'Select pages by thumbnail')}</button>
                <label className={css.fieldRow}>{tx('开始页', 'Start page')}<input className={css.input} data-testid="doc-context-ms" disabled={saving} inputMode="numeric" value={manualStart} onChange={e => changeManual(setManualStart, e.target.value)} /></label>
                <label className={css.fieldRow}>{tx('结束页', 'End page')}<input className={css.input} data-testid="doc-context-me" disabled={saving} inputMode="numeric" value={manualEnd} onChange={e => changeManual(setManualEnd, e.target.value)} /></label>
                {manualError && <div className={css.limitHint} data-testid="doc-context-manual-error">{manualError}</div>}
                <button type="button" className={css.btn} data-testid="doc-context-manual-add" disabled={saving} onClick={addManual}>{tx('选择范围', 'Select range')}</button>
              </div>
            )}
            {projectName === undefined
              ? <PdfContextMode value={contextMode} onChange={setContextMode} />
              : <p className={css.processingNote}>{tx('项目会保留页面图片和 OCR。已识别的页面使用本地缓存，其他页面会发送到 DeepSeek，需配置 DeepSeek 官方 API Key，并按服务计费。', 'The project keeps page images and OCR text. Cached OCR stays local. Uncached pages go to DeepSeek and require an official DeepSeek API key. DeepSeek charges apply.')}</p>}
            <div className={css.footer}>
              <div className={css.summary} data-testid="doc-context-summary">
                {hasScope ? (
                  <>{tx('已选择：', 'Selected: ')}{selection.title || (wholeChecked ? tx('整份文档', 'Entire document') : pdfRangesText(selection.ranges))}<br />{pdfRangesText(selection.ranges)} · {tx('共 ' + selectionCount + ' 页', selectionCount + ' pages')}</>
                ) : (
                  <>{tab === 'manual' ? tx('请选择或重新确认页码范围。', 'Select or reconfirm the page range.') : tx('已选择：未选择章节', 'Selected: no chapter selected')}</>
                )}
              </div>
              <div className={css.footerBtns}>
                <button type="button" className={css.btn} data-testid="doc-context-cancel2" disabled={saving} onClick={() => void requestCancel()}>{tx('取消', 'Cancel')}</button>
                <button type="button" className={css.btn} data-testid="doc-context-preview" disabled={saving || !doc || binaryAvailable !== true} aria-describedby={binaryAvailable === false ? 'doc-context-preview-disabled' : undefined} onClick={() => void openPreview()}>{tx('预览', 'Preview')}</button>
                <button type="button" className={css.btnPrimary} data-testid="doc-context-add" disabled={saving || !hasScope} onClick={() => void commit()}>{saving ? tx('正在处理…', 'Processing…') : projectName ? tx('存入项目 · ', 'Save to project · ') + projectName : tx('加入提问草稿', 'Add to question draft')}</button>
              </div>
            </div>
            {binaryAvailable === false && <div className={css.limitHint} id="doc-context-preview-disabled" data-testid="doc-context-preview-disabled">{tx('本地 PDF 数据不可用，请重新导入。', 'The local PDF data is unavailable. Import it again.')}</div>}
            {previewError && <div className={css.blockMsg} data-testid="doc-context-preview-error" role="alert">{previewError}</div>}
          </>
        ) : null}
        {confirming && (
          <div className={css.confirm} data-testid="doc-context-confirm">
            <div>{projectName ? tx('将存入 ' + countPdfRangePages(confirming.ranges) + ' 页，处理可能需要一些时间。继续吗？', 'Saving ' + countPdfRangePages(confirming.ranges) + ' pages may take some time. Continue?') : tx('本次将加入 ' + countPdfRangePages(confirming.ranges) + ' 页内容，处理时间和模型输入都会比较大。确认继续？', 'This will add ' + countPdfRangePages(confirming.ranges) + ' pages and use substantial processing time and model input. Continue?')}</div>
            <div className={css.confirmBtns}>
              <button className={css.btnPrimary} data-testid="doc-context-confirm-yes" onClick={() => { const s = confirming; setConfirming(null); finishAdd(s) }}>{tx('继续加入', 'Continue')}</button>
              <button className={css.btn} data-testid="doc-context-confirm-no" onClick={() => setConfirming(null)}>{tx('取消', 'Cancel')}</button>
            </div>
          </div>
        )}
        {blockMsg && <div className={css.blockMsg} data-testid="doc-context-block" role="alert">{blockMsg}</div>}
      </div>
      {visualPages && doc && <PdfAttachmentPagePicker source={doc.id} onCancel={() => setVisualPages(false)} onSelect={ranges => {
        setVisualPages(false)
        setManualStart(ranges.length === 1 ? String(ranges[0].startPage) : '')
        setManualEnd(ranges.length === 1 ? String(ranges[0].endPage) : '')
        setManualError(null)
        setManualSel({ kind: 'manual', title: pdfRangesText(ranges), ranges })
      }} />}
    </div>
  )
}

function ChapterTreeCheck({ nodes, checked, pageCount, bookmarkRangePreferences, preferenceBusy, onToggle, onModeChange }: { nodes: ChapterNode[]; checked: Set<string>; pageCount: number; bookmarkRangePreferences?: Record<string, BookmarkRangeEndMode>; preferenceBusy: (chapterId: string) => boolean; onToggle: (id: string) => void; onModeChange: (id: string, mode: BookmarkRangeEndMode) => void }) {
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
                  <ChapterRangeModeControl chapterId={n.id} chapterTitle={n.title} mode={mode} presentation={presentation} disabled={preferenceBusy(n.id)} onChange={nextMode => onModeChange(n.id, nextMode)} />
                  <span id={'doc-context-range-help-' + n.id} className={css.srOnly}>{tx('范围语义：左闭右开表示到下一章节起始页前一页；左闭右闭表示包含所示终点页。', 'Range semantics: exclusive ends before the next chapter starts; inclusive includes the displayed end page.')}</span>
                </span>
              ) : <span className={css.treeRange}>{tx('无法定位页码', 'Page unavailable')}</span>}
            </div>
            {n.children.length > 0 && <ChapterTreeCheck nodes={n.children} checked={checked} pageCount={pageCount} bookmarkRangePreferences={bookmarkRangePreferences} preferenceBusy={preferenceBusy} onToggle={onToggle} onModeChange={onModeChange} />}
          </div>
        )
      })}
    </div>
  )
}
