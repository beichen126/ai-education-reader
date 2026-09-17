// PDF preview panel: a responsive dialog opened from a Composer "PDF" button.
// Stage 4: [按章节] / [选页] with the parsed outline. Stage 6: large-context
// safety — >30 pages asks for confirmation (soft), >120 is blocked (product
// hard limit), generation tracks real accumulated bytes and the panel shows a
// representative preview (first-3 + last-3) for large contexts while keeping all
// Blobs. Stage 9.1: multi-chapter selection — several (non-contiguous) chapters
// normalize into ONE PdfRange[] context; adding to the draft no longer closes
// the panel so the user can keep selecting and add a second group.
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Modal, Button, Input } from '../dsh/primitives'
import { formatBytes } from '../storage/diagnostics'
import { usePdfPreview, validatePdfRange } from './use-pdf-preview'
import { PdfOutlineSelector } from './PdfOutlineSelector'
import {
  PDF_CONTEXT_SOFT_WARNING_PAGES, MAX_PDF_CONTEXT_PAGES,
  needsPdfContextSoftConfirm, exceedsPdfContextHardLimit,
  normalizePdfRanges, countPdfRangePages, pdfRangesText, pdfSelectionTitle,
  type PdfAddPayload, type PdfAddResult, type PdfRange, type RenderedPdfPage,
} from './pdf-types'
import type { PdfOutlineItem } from './pdf-outline'
import css from './pdf-panel.module.css'
import { localizedErrorText, tx } from '../engine/locale'

export type { PdfAddResult } from './pdf-types'

/** Collect the SELECTED outline nodes that carry a usable page range. */
function collectNodes(items: PdfOutlineItem[], ids: ReadonlySet<string>, out: PdfOutlineItem[] = []): PdfOutlineItem[] {
  for (const it of items) {
    if (ids.has(it.id) && it.startPage != null && it.endPage != null) out.push(it)
    collectNodes(it.children, ids, out)
  }
  return out
}

function rangeOf(node: PdfOutlineItem): PdfRange { return { startPage: node.startPage!, endPage: node.endPage! } }

function miB(bytes: number): string { return (bytes / (1024 * 1024)).toFixed(1) + ' MiB' }

export function PdfPanel({
  initialFile, onClose, onAddToDraft,
}: {
  initialFile?: File
  onClose: () => void
  onAddToDraft: (payload: PdfAddPayload) => Promise<PdfAddResult>
}) {
  const { doc, pages, status, error, progress, outline, outlineStatus, outlineError, documentId, documentSaveError, selectFile, generateRanges, clearPreview } = usePdfPreview()
  const [mode, setMode] = useState<'chapter' | 'manual'>('chapter')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const [selError, setSelError] = useState<string | null>(null)
  const [lastRanges, setLastRanges] = useState<PdfRange[] | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<{ ranges: PdfRange[]; count: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const [addMsg, setAddMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { if (initialFile) void selectFile(initialFile) }, [initialFile])

  const hasOutline = outlineStatus === 'ready' && !!outline && outline.items.length > 0
  const inChapterMode = hasOutline && mode === 'chapter'
  const selectedNodes = collectNodes(outline?.items ?? [], selectedIds)
  const selectedRanges = normalizePdfRanges(selectedNodes.map(rangeOf))
  const selectedCount = countPdfRangePages(selectedRanges)
  const generating = progress !== undefined

  const resetSelection = () => {
    setSelectedIds(new Set()); setExpandedIds(new Set()); setMode('chapter'); setSelError(null); setLastRanges(null); setAddMsg(null); setPendingConfirm(null)
  }

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) { setStart(''); setEnd(''); resetSelection(); await selectFile(f) }
    e.target.value = ''
  }

  const changeMode = (m: 'chapter' | 'manual') => {
    if (m === mode) return
    setMode(m); clearPreview(); setAddMsg(null); setSelError(null); setLastRanges(null); setPendingConfirm(null)
  }

  const toggleSelect = (node: PdfOutlineItem) => {
    setAddMsg(null); setSelError(null); setPendingConfirm(null)
    setSelectedIds(prev => {
      const n = new Set(prev)
      if (n.has(node.id)) n.delete(node.id); else n.add(node.id)
      return n
    })
    clearPreview()
    setLastRanges(null)
  }

  const toggle = (id: string) => setExpandedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const startGenerateRanges = (ranges: PdfRange[]) => {
    setLastRanges(ranges)
    void generateRanges(ranges)
  }

  const onGenerate = () => {
    setSelError(null)
    if (inChapterMode) {
      if (selectedNodes.length === 0) { setSelError(tx('请先选择一个章节。', 'Select a chapter first.')); return }
      if (selectedCount > MAX_PDF_CONTEXT_PAGES) {
        setSelError(tx('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请减少选择的章节范围后重试。', 'You can process up to ' + MAX_PDF_CONTEXT_PAGES + ' pages at a time. Select fewer chapters and try again.'))
        return
      }
      if (needsPdfContextSoftConfirm(selectedCount)) { setPendingConfirm({ ranges: selectedRanges, count: selectedCount }); return }
      startGenerateRanges(selectedRanges)
    } else {
      const s = Number(start) || 0; const e2 = Number(end) || 0
      if (s < 1 || e2 < 1 || e2 < s) {
        setSelError(validatePdfRange(start, end, doc?.pageCount ?? 0))
        return
      }
      const ranges = normalizePdfRanges([{ startPage: s, endPage: e2 }])
      const count = countPdfRangePages(ranges)
      if (count > MAX_PDF_CONTEXT_PAGES) {
        setSelError(tx('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请减少页码范围后重试。', 'You can process up to ' + MAX_PDF_CONTEXT_PAGES + ' pages at a time. Reduce the page range and try again.'))
        return
      }
      if (needsPdfContextSoftConfirm(count)) { setPendingConfirm({ ranges, count }); return }
      startGenerateRanges(ranges)
    }
  }

  const confirmLarge = () => {
    if (!pendingConfirm) return
    setPendingConfirm(null)
    startGenerateRanges(pendingConfirm.ranges)
  }

  const addToDraft = async () => {
    if (!doc || pages.length === 0 || adding) return
    setAdding(true); setAddMsg(null)
    try {
      const selection = inChapterMode && selectedNodes.length > 0
        ? {
            kind: 'outline' as const,
            // Single chapter: its own title. Multiple chapters: ALL nodes joined
            // ('第二章、第五章') in PDF outline order — never just the first one.
            title: pdfSelectionTitle(selectedNodes.map(n => n.title)),
            ranges: lastRanges ?? selectedRanges,
            selectedChapterIds: [...selectedIds],
          }
        : { kind: 'manual' as const, ranges: lastRanges ?? [{ startPage: pages[0].pageNumber, endPage: pages[pages.length - 1].pageNumber }] }
      const res = await onAddToDraft({
        fileName: doc.fileName,
        ...(documentId ? { documentId } : {}),
        selection,
        pages,
      })
      setAddMsg(res.ok ? tx('已加入 ' + res.count + ' 页', 'Added ' + res.count + ' pages') : localizedErrorText(res.error, 'Unable to add the PDF pages to the chat.'))
    } catch { setAddMsg(tx('无法将 PDF 页面加入对话。', 'Unable to add the PDF pages to the chat.')) }
    setAdding(false)
  }

  const addBarRange = pdfRangesText(lastRanges ?? (pages.length > 0 ? [{ startPage: pages[0].pageNumber, endPage: pages[pages.length - 1].pageNumber }] : []))
  const addBarTitle = inChapterMode && selectedNodes[0] ? selectedNodes[0].title + ' · ' : ''
  const visiblePages = pages.filter(p => p.previewUrl)
  const largePreview = pages.length > PDF_CONTEXT_SOFT_WARNING_PAGES

  return (
    <>
      <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={onPick} />
      <Modal open onClose={onClose} title={tx('PDF 本地预览', 'Local PDF preview')} closeLabel={tx('关闭', 'Close')} className={css.modal}>
        <div className={css.column}>
          {status === 'loading' && <div className={css.empty}>{tx('正在打开 PDF…', 'Opening PDF…')}</div>}

          {status === 'error' && (
            <>
              <div className={css.error} data-testid="pdf-error">{error ? localizedErrorText(error, 'PDF processing failed.') : tx('PDF 处理失败。', 'PDF processing failed.')}</div>
              <div className={css.actions}><Button variant="outline" onClick={() => fileRef.current?.click()}>{tx('重新选择', 'Choose another')}</Button></div>
            </>
          )}

          {status === 'ready' && doc && (
            <>
              <div className={css.fileRow}>
                <span className={css.fileName}>{doc.fileName}</span>
                <span className={css.fileMeta}>{formatBytes(doc.fileSize)} · {tx('共 ' + doc.pageCount + ' 页', doc.pageCount + ' pages')}</span>
              </div>

              {documentSaveError && (
                <div className={css.warning} data-testid="pdf-doc-warning">{localizedErrorText(documentSaveError, 'The PDF opened, but it could not be saved to the library.')}</div>
              )}

              {outlineStatus === 'loading' && <div className={css.empty} data-testid="pdf-outline-loading">{tx('正在读取 PDF 书签…', 'Reading PDF bookmarks…')}</div>}
              {outlineStatus === 'error' && <div className={css.error} data-testid="pdf-outline-error">{outlineError ? localizedErrorText(outlineError, 'Unable to read PDF bookmarks. You can still select pages manually.') : tx('无法读取该 PDF 的书签，可以继续手动选择页面。', 'Unable to read PDF bookmarks. You can still select pages manually.')}</div>}

              {hasOutline && (
                <div className={css.modeRow}>
                  <button type="button" className={css.segBtn + (mode === 'chapter' ? ' ' + css.segActive : '')} data-testid="pdf-mode-chapter" aria-pressed={mode === 'chapter'} onClick={() => changeMode('chapter')}>{tx('按章节', 'By chapter')}</button>
                  <button type="button" className={css.segBtn + (mode === 'manual' ? ' ' + css.segActive : '')} data-testid="pdf-mode-manual" aria-pressed={mode === 'manual'} onClick={() => changeMode('manual')}>{tx('选页', 'Select pages')}</button>
                </div>
              )}

              {(inChapterMode) ? (
                <>
                  <PdfOutlineSelector items={outline!.items} selectedIds={selectedIds} expandedIds={expandedIds} onToggleSelect={toggleSelect} onToggle={toggle} />
                  <div className={css.summary} data-testid="pdf-summary">
                    <div className={css.summaryLabel}>{tx('已选择', 'Selected')}</div>
                    {selectedNodes.length === 0 ? (
                      <div className={css.summaryEmpty} data-testid="pdf-summary-empty">{tx('请在目录中选择章节（可多选）。', 'Select one or more chapters from the outline.')}</div>
                    ) : (
                      <>
                        <div className={css.summaryTotal} data-testid="pdf-summary-total">{tx(selectedNodes.length + ' 个章节 · 共 ' + selectedCount + ' 页', selectedNodes.length + ' chapters · ' + selectedCount + ' pages')}</div>
                        {selectedNodes.map((n, i) => (
                          <div className={css.summaryRow} key={n.id} data-testid={'pdf-summary-item-' + n.id}>
                            <span className={css.summaryTitle} data-testid={i === 0 ? 'pdf-summary-title' : undefined}>{n.title}</span>
                            <span className={css.summaryRange} data-testid={i === 0 ? 'pdf-summary-range' : undefined}>
                              {n.startPage === n.endPage ? tx('PDF 第 ' + n.startPage + ' 页', 'PDF page ' + n.startPage) : 'PDF ' + n.startPage + '–' + n.endPage}
                            </span>
                          </div>
                        ))}
                        <div className={css.summaryCount} data-testid="pdf-summary-count">{tx(selectedCount + ' 页', selectedCount + ' pages')}</div>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className={css.rangeRow}>
                    <div className={css.rangeField}><label className={css.rangeLabel}>{tx('开始页', 'Start page')}</label><Input className={css.rangeInput} inputMode="numeric" data-testid="pdf-start" value={start} onChange={e => setStart(e.target.value)} placeholder="1" /></div>
                    <div className={css.rangeField}><label className={css.rangeLabel}>{tx('结束页', 'End page')}</label><Input className={css.rangeInput} inputMode="numeric" data-testid="pdf-end" value={end} onChange={e => setEnd(e.target.value)} placeholder={String(doc.pageCount)} /></div>
                  </div>
                </>
              )}

              {selError && <div className={css.error} data-testid="pdf-error">{selError}</div>}
              {error && <div className={css.error} data-testid="pdf-error">{localizedErrorText(error, 'PDF processing failed.')}</div>}

              <div className={css.actions}>
                <Button variant="primary" data-testid="pdf-generate" disabled={generating || (inChapterMode && selectedNodes.length === 0)} onClick={onGenerate}>
                  {generating ? tx('正在渲染…', 'Rendering…') : tx('生成预览', 'Generate preview')}
                </Button>
                <Button variant="outline" disabled={generating} onClick={() => fileRef.current?.click()}>{tx('重新选择', 'Choose another')}</Button>
              </div>

              {pendingConfirm && (
                <div className={css.confirmBox} data-testid="pdf-large-confirm">
                  <div className={css.confirmText}>{tx('本次将处理 ' + pendingConfirm.count + ' 页。', 'This will process ' + pendingConfirm.count + ' pages.')}</div>
                  <div className={css.confirmHint}>{tx('大范围 PDF 需要更多本地处理时间和内存，并会占用更多模型视觉上下文。', 'Large PDF ranges need more local processing time and memory, and use more model vision context.')}</div>
                  <div className={css.actions}>
                    <Button variant="primary" data-testid="pdf-large-confirm-yes" onClick={confirmLarge}>{tx('继续处理 ' + pendingConfirm.count + ' 页', 'Process ' + pendingConfirm.count + ' pages')}</Button>
                    <Button variant="outline" data-testid="pdf-large-confirm-no" onClick={() => setPendingConfirm(null)}>{tx('取消', 'Cancel')}</Button>
                  </div>
                </div>
              )}

              {generating && progress && (
                <div className={css.progress} data-testid="pdf-progress">{tx('正在处理 ', 'Processing ')}{progress.done} / {progress.total}{tx(' 页 · 已生成 ', ' pages · generated ')}{miB(progress.bytes)}</div>
              )}

              {!generating && pages.length > 0 && (
                <>
                  <div className={css.progress}>{tx('共生成 ' + pages.length + ' 页', 'Generated ' + pages.length + ' pages')}</div>
                  {largePreview && <div className={css.empty} data-testid="pdf-preview-note">{tx('以下仅展示部分页面预览（共 ' + pages.length + ' 页，Blob 已全部生成）。', 'Only a sample is shown below. All ' + pages.length + ' page blobs were generated.')}</div>}
                  <div className={css.addBar}>
                    <span className={css.fileName}>{doc.fileName}</span>
                    <span className={css.fileMeta}>{addBarTitle}{addBarRange} · {tx('共 ' + pages.length + ' 页', pages.length + ' pages')}</span>
                  </div>
                  <div className={css.actions}>
                    <Button variant="primary" data-testid="pdf-add" disabled={adding} onClick={() => void addToDraft()}>{adding ? tx('正在加入 ' + pages.length + ' 页…', 'Adding ' + pages.length + ' pages…') : tx('加入对话', 'Add to chat')}</Button>
                    <Button variant="outline" disabled={adding} onClick={() => fileRef.current?.click()}>{tx('重新选择', 'Choose another')}</Button>
                    <Button variant="outline" data-testid="pdf-done" onClick={onClose}>{tx('完成', 'Done')}</Button>
                  </div>
                  {addMsg && <div className={css.progress} data-testid="pdf-add-msg">{addMsg}</div>}
                  <div className={css.pages}>
                    {visiblePages.map(p => (
                      <div className={css.pageItem} key={p.pageNumber} data-testid="pdf-page">
                        <span className={css.pageLabel}>{tx('第 ' + p.pageNumber + ' 页', 'Page ' + p.pageNumber)}</span>
                        <img className={css.pageImg} src={p.previewUrl} alt={tx('第 ' + p.pageNumber + ' 页', 'Page ' + p.pageNumber)} width={p.width} height={p.height} />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {!generating && pages.length === 0 && !error && !selError && !pendingConfirm && (
                <div className={css.empty}>{inChapterMode ? tx('勾选章节后点击“生成预览”。', 'Select chapters, then choose “Generate preview”.') : tx('输入页码范围后点击“生成预览”。', 'Enter a page range, then choose “Generate preview”.')}</div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
