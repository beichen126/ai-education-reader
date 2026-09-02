// PDF preview panel: a responsive dialog opened from a Composer "PDF" button.
// Stage 4: when the PDF has bookmarks, offer [按章节] / [选页] — the chapter path
// consumes the parsed PdfOutlineResult (Stage 3) verbatim, the user picks a
// node, sees its range summary, then clicks 生成预览 (which reuses the SAME
// Stage 1 render + Stage 2 add-to-draft pipeline). Modes keep independent state;
// switching mode only clears the rendered preview, never the doc/inputs/selection.
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Modal, Button, Input } from '../dsh/primitives'
import { formatBytes } from '../storage/diagnostics'
import { usePdfPreview } from './use-pdf-preview'
import { PdfOutlineSelector } from './PdfOutlineSelector'
import { MAX_PREVIEW_PAGES, type PdfAddPayload, type RenderedPdfPage } from './pdf-types'
import type { PdfOutlineItem } from './pdf-outline'
import css from './pdf-panel.module.css'

export type PdfAddResult = { ok: boolean; count: number; error: string }

function findNode(items: PdfOutlineItem[], id: string | null): PdfOutlineItem | undefined {
  if (!id) return undefined
  for (const it of items) {
    if (it.id === id) return it
    const d = findNode(it.children, id)
    if (d) return d
  }
  return undefined
}

export function PdfPanel({
  initialFile, onClose, onAddToDraft,
}: {
  initialFile?: File
  onClose: () => void
  onAddToDraft: (payload: PdfAddPayload) => Promise<PdfAddResult>
}) {
  const { doc, pages, status, error, progress, outline, outlineStatus, outlineError, selectFile, generate, clearPreview } = usePdfPreview()
  const [mode, setMode] = useState<'chapter' | 'manual'>('chapter')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const [selError, setSelError] = useState<string | null>(null)
  const [lastRange, setLastRange] = useState<{ start: number; end: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const [addMsg, setAddMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { if (initialFile) void selectFile(initialFile) }, [initialFile])

  const hasOutline = outlineStatus === 'ready' && !!outline && outline.items.length > 0
  const inChapterMode = hasOutline && mode === 'chapter'
  const selectedNode = findNode(outline?.items ?? [], selectedId)
  const generating = progress !== undefined

  const resetSelection = () => {
    setSelectedId(null); setExpandedIds(new Set()); setMode('chapter'); setSelError(null); setLastRange(null); setAddMsg(null)
  }

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) { setStart(''); setEnd(''); resetSelection(); await selectFile(f) }
    e.target.value = ''
  }

  const changeMode = (m: 'chapter' | 'manual') => {
    if (m === mode) return
    setMode(m); clearPreview(); setAddMsg(null); setSelError(null); setLastRange(null)
  }

  const selectChapter = (node: PdfOutlineItem) => {
    setSelError(null); setAddMsg(null)
    if (node.id !== selectedId) { setSelectedId(node.id); clearPreview(); setLastRange(null) }
  }

  const toggle = (id: string) => setExpandedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const onGenerate = () => {
    setSelError(null)
    if (inChapterMode) {
      const sel = selectedNode
      if (!sel || sel.startPage == null || sel.endPage == null) { setSelError('请先选择一个章节。'); return }
      const count = sel.endPage - sel.startPage + 1
      if (count > MAX_PREVIEW_PAGES) {
        setSelError('该章节共 ' + count + ' 页，当前单次最多处理 ' + MAX_PREVIEW_PAGES + ' 页。你可以切换到“选页”模式，选择其中一部分。')
        return
      }
      setLastRange({ start: sel.startPage, end: sel.endPage })
      void generate(String(sel.startPage), String(sel.endPage))
    } else {
      setLastRange({ start: Number(start) || 0, end: Number(end) || 0 })
      void generate(start, end)
    }
  }

  const addToDraft = async () => {
    if (!doc || pages.length === 0 || adding) return
    setAdding(true); setAddMsg(null)
    try {
      const selection = inChapterMode && selectedNode && selectedNode.startPage != null && selectedNode.endPage != null
        ? { kind: 'outline' as const, title: selectedNode.title, startPage: selectedNode.startPage, endPage: selectedNode.endPage }
        : { kind: 'manual' as const, startPage: lastRange?.start ?? pages[0].pageNumber, endPage: lastRange?.end ?? pages[pages.length - 1].pageNumber }
      const res = await onAddToDraft({ fileName: doc.fileName, selection, pages })
      if (res.ok) { setAddMsg('已加入 ' + res.count + ' 页'); setTimeout(() => onClose(), 700) } else { setAddMsg(res.error) }
    } catch { setAddMsg('无法将 PDF 页面加入对话。') }
    setAdding(false)
  }

  const rangeLabel = lastRange ? (lastRange.start === lastRange.end ? 'PDF 第 ' + lastRange.start + ' 页' : 'PDF ' + lastRange.start + '–' + lastRange.end) : ''
  const selRange = selectedNode ? (selectedNode.startPage === selectedNode.endPage ? 'PDF 第 ' + selectedNode.startPage + ' 页' : 'PDF ' + selectedNode.startPage + '–' + selectedNode.endPage) : ''

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
                  <PdfOutlineSelector items={outline!.items} selectedId={selectedId} expandedIds={expandedIds} onSelect={selectChapter} onToggle={toggle} />
                  <div className={css.summary} data-testid="pdf-summary">
                    <div className={css.summaryLabel}>已选择</div>
                    {selectedNode ? (
                      <>
                        <div className={css.summaryTitle} data-testid="pdf-summary-title">{selectedNode.title}</div>
                        <div className={css.summaryRange} data-testid="pdf-summary-range">{selRange}</div>
                        <div className={css.summaryCount} data-testid="pdf-summary-count">{selectedNode.endPage! - selectedNode.startPage! + 1} 页</div>
                      </>
                    ) : (
                      <div className={css.summaryEmpty}>请在左侧选择章节。</div>
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
                <Button variant="primary" data-testid="pdf-generate" disabled={generating || (inChapterMode && !selectedNode)} onClick={onGenerate}>
                  {generating ? '正在渲染…' : '生成预览'}
                </Button>
                <Button variant="outline" disabled={generating} onClick={() => fileRef.current?.click()}>重新选择</Button>
              </div>

              {generating && progress && <div className={css.progress}>正在渲染 {progress.done} / {progress.total} 页</div>}

              {!generating && pages.length > 0 && (
                <>
                  <div className={css.progress}>共生成 {pages.length} 页</div>
                  <div className={css.addBar}>
                    <span className={css.fileName}>{doc.fileName}</span>
                    <span className={css.fileMeta}>{inChapterMode && selectedNode ? selectedNode.title + ' · ' : ''}{rangeLabel} · 共 {pages.length} 页</span>
                  </div>
                  <div className={css.actions}>
                    <Button variant="primary" data-testid="pdf-add" disabled={adding} onClick={() => void addToDraft()}>{adding ? '正在加入 ' + pages.length + ' 页…' : '加入对话'}</Button>
                    <Button variant="outline" disabled={adding} onClick={() => fileRef.current?.click()}>重新选择</Button>
                  </div>
                  {addMsg && <div className={css.progress} data-testid="pdf-add-msg">{addMsg}</div>}
                  <div className={css.pages}>
                    {pages.map(p => (
                      <div className={css.pageItem} key={p.pageNumber} data-testid="pdf-page">
                        <span className={css.pageLabel}>第 {p.pageNumber} 页</span>
                        <img className={css.pageImg} src={p.previewUrl} alt={'第 ' + p.pageNumber + ' 页'} width={p.width} height={p.height} />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {!generating && pages.length === 0 && !error && !selError && (
                <div className={css.empty}>{inChapterMode ? '选择一个章节后点击“生成预览”。' : '输入页码范围后点击“生成预览”。'}</div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  )
}