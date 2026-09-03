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
  type PdfAddPayload, type PdfRange, type RenderedPdfPage,
} from './pdf-types'
import type { PdfOutlineItem } from './pdf-outline'
import css from './pdf-panel.module.css'

export type PdfAddResult = { ok: boolean; count: number; error: string }

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
  const { doc, pages, status, error, progress, outline, outlineStatus, outlineError, selectFile, generateRanges, clearPreview } = usePdfPreview()
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
      if (selectedNodes.length === 0) { setSelError('请先选择一个章节。'); return }
      if (selectedCount > MAX_PDF_CONTEXT_PAGES) {
        setSelError('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请减少选择的章节范围后重试。')
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
        setSelError('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页。请减少页码范围后重试。')
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
      const res = await onAddToDraft({ fileName: doc.fileName, selection, pages })
      setAddMsg(res.ok ? '已加入 ' + res.count + ' 页' : res.error)
    } catch { setAddMsg('无法将 PDF 页面加入对话。') }
    setAdding(false)
  }

  const addBarRange = pdfRangesText(lastRanges ?? (pages.length > 0 ? [{ startPage: pages[0].pageNumber, endPage: pages[pages.length - 1].pageNumber }] : []))
  const addBarTitle = inChapterMode && selectedNodes[0] ? selectedNodes[0].title + ' · ' : ''
  const visiblePages = pages.filter(p => p.previewUrl)
  const largePreview = pages.length > PDF_CONTEXT_SOFT_WARNING_PAGES

  return (
    <>
      <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={onPick} />
      <Modal open onClose={onClose} title="PDF 本地预览" closeLabel="关闭" className={css.modal}>
        <div className={css.column}>
          {status === 'loading' && <div className={css.empty}>正在打开 PDF…</div>}

          {status === 'error' && (
            <>
              <div className={css.error} data-testid="pdf-error">{error || 'PDF 处理失败。'}</div>
              <div className={css.actions}><Button variant="outline" onClick={() => fileRef.current?.click()}>重新选择</Button></div>
            </>
          )}

          {status === 'ready' && doc && (
            <>
              <div className={css.fileRow}>
                <span className={css.fileName}>{doc.fileName}</span>
                <span className={css.fileMeta}>{formatBytes(doc.fileSize)} · 共 {doc.pageCount} 页</span>
              </div>

              {outlineStatus === 'loading' && <div className={css.empty} data-testid="pdf-outline-loading">正在读取 PDF 书签…</div>}
              {outlineStatus === 'error' && <div className={css.error} data-testid="pdf-outline-error">{outlineError || '无法读取该 PDF 的书签，可以继续手动选择页面。'}</div>}

              {hasOutline && (
                <div className={css.modeRow}>
                  <button type="button" className={css.segBtn + (mode === 'chapter' ? ' ' + css.segActive : '')} data-testid="pdf-mode-chapter" aria-pressed={mode === 'chapter'} onClick={() => changeMode('chapter')}>按章节</button>
                  <button type="button" className={css.segBtn + (mode === 'manual' ? ' ' + css.segActive : '')} data-testid="pdf-mode-manual" aria-pressed={mode === 'manual'} onClick={() => changeMode('manual')}>选页</button>
                </div>
              )}

              {(inChapterMode) ? (
                <>
                  <PdfOutlineSelector items={outline!.items} selectedIds={selectedIds} expandedIds={expandedIds} onToggleSelect={toggleSelect} onToggle={toggle} />
                  <div className={css.summary} data-testid="pdf-summary">
                    <div className={css.summaryLabel}>已选择</div>
                    {selectedNodes.length === 0 ? (
                      <div className={css.summaryEmpty} data-testid="pdf-summary-empty">请在目录中选择章节（可多选）。</div>
                    ) : (
                      <>
                        <div className={css.summaryTotal} data-testid="pdf-summary-total">{selectedNodes.length} 个章节 · 共 {selectedCount} 页</div>
                        {selectedNodes.map((n, i) => (
                          <div className={css.summaryRow} key={n.id} data-testid={'pdf-summary-item-' + n.id}>
                            <span className={css.summaryTitle} data-testid={i === 0 ? 'pdf-summary-title' : undefined}>{n.title}</span>
                            <span className={css.summaryRange} data-testid={i === 0 ? 'pdf-summary-range' : undefined}>
                              {n.startPage === n.endPage ? 'PDF 第 ' + n.startPage + ' 页' : 'PDF ' + n.startPage + '–' + n.endPage}
                            </span>
                          </div>
                        ))}
                        <div className={css.summaryCount} data-testid="pdf-summary-count">{selectedCount} 页</div>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className={css.rangeRow}>
                    <div className={css.rangeField}><label className={css.rangeLabel}>开始页</label><Input className={css.rangeInput} inputMode="numeric" data-testid="pdf-start" value={start} onChange={e => setStart(e.target.value)} placeholder="1" /></div>
                    <div className={css.rangeField}><label className={css.rangeLabel}>结束页</label><Input className={css.rangeInput} inputMode="numeric" data-testid="pdf-end" value={end} onChange={e => setEnd(e.target.value)} placeholder={String(doc.pageCount)} /></div>
                  </div>
                </>
              )}

              {selError && <div className={css.error} data-testid="pdf-error">{selError}</div>}
              {error && <div className={css.error} data-testid="pdf-error">{error}</div>}

              <div className={css.actions}>
                <Button variant="primary" data-testid="pdf-generate" disabled={generating || (inChapterMode && selectedNodes.length === 0)} onClick={onGenerate}>
                  {generating ? '正在渲染…' : '生成预览'}
                </Button>
                <Button variant="outline" disabled={generating} onClick={() => fileRef.current?.click()}>重新选择</Button>
              </div>

              {pendingConfirm && (
                <div className={css.confirmBox} data-testid="pdf-large-confirm">
                  <div className={css.confirmText}>本次将处理 {pendingConfirm.count} 页。</div>
                  <div className={css.confirmHint}>大范围 PDF 需要更多本地处理时间和内存，并会占用更多模型视觉上下文。</div>
                  <div className={css.actions}>
                    <Button variant="primary" data-testid="pdf-large-confirm-yes" onClick={confirmLarge}>继续处理 {pendingConfirm.count} 页</Button>
                    <Button variant="outline" data-testid="pdf-large-confirm-no" onClick={() => setPendingConfirm(null)}>取消</Button>
                  </div>
                </div>
              )}

              {generating && progress && (
                <div className={css.progress} data-testid="pdf-progress">正在处理 {progress.done} / {progress.total} 页 · 已生成 {miB(progress.bytes)}</div>
              )}

              {!generating && pages.length > 0 && (
                <>
                  <div className={css.progress}>共生成 {pages.length} 页</div>
                  {largePreview && <div className={css.empty} data-testid="pdf-preview-note">以下仅展示部分页面预览（共 {pages.length} 页，Blob 已全部生成）。</div>}
                  <div className={css.addBar}>
                    <span className={css.fileName}>{doc.fileName}</span>
                    <span className={css.fileMeta}>{addBarTitle}{addBarRange} · 共 {pages.length} 页</span>
                  </div>
                  <div className={css.actions}>
                    <Button variant="primary" data-testid="pdf-add" disabled={adding} onClick={() => void addToDraft()}>{adding ? '正在加入 ' + pages.length + ' 页…' : '加入对话'}</Button>
                    <Button variant="outline" disabled={adding} onClick={() => fileRef.current?.click()}>重新选择</Button>
                    <Button variant="outline" data-testid="pdf-done" onClick={onClose}>完成</Button>
                  </div>
                  {addMsg && <div className={css.progress} data-testid="pdf-add-msg">{addMsg}</div>}
                  <div className={css.pages}>
                    {visiblePages.map(p => (
                      <div className={css.pageItem} key={p.pageNumber} data-testid="pdf-page">
                        <span className={css.pageLabel}>第 {p.pageNumber} 页</span>
                        <img className={css.pageImg} src={p.previewUrl} alt={'第 ' + p.pageNumber + ' 页'} width={p.width} height={p.height} />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {!generating && pages.length === 0 && !error && !selError && !pendingConfirm && (
                <div className={css.empty}>{inChapterMode ? '勾选章节后点击“生成预览”。' : '输入页码范围后点击“生成预览”。'}</div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
