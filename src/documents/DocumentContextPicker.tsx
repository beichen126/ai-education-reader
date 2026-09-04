
import { useEffect, useMemo, useState } from 'react'
import { listDocumentSummaries, getDocumentContextDescriptor, type DocumentContextDescriptor, type DocumentSummary } from './document-service'
import { buildChapterNodesSelection, selectableChapterRange } from './document-context'
import { normalizePdfRanges, countPdfRangePages, pdfRangesText, needsPdfContextSoftConfirm, exceedsPdfContextHardLimit, validatePdfRange, MAX_PDF_CONTEXT_PAGES, type PdfRange, type PdfSelection } from '../pdf/pdf-types'
import type { ChapterNode } from './document-types'
import css from './document-context-picker.module.css'

type Props = {
  documentId?: string
  onCancel: () => void
  onAdd: (selection: PdfSelection, documentId: string, fileName: string) => void
}

export function DocumentContextPicker({ documentId, onCancel, onAdd }: Props) {
  const [doc, setDoc] = useState<DocumentContextDescriptor | null>(null)
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'toc' | 'manual'>('toc')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [blockMsg, setBlockMsg] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<PdfSelection | null>(null)

  // Stage 1: pick a document from the library if none pre-scoped.
  const needDocPick = !documentId
  useEffect(() => { if (needDocPick) { void listDocumentSummaries().then(setDocs).catch(() => setDocs([])) } }, [needDocPick])
  useEffect(() => { if (documentId) { void getDocumentContextDescriptor(documentId).then(d => { setDoc(d); if (!d) setBlockMsg('这份文档不存在或已被删除。') }) } }, [documentId])

  const selectDoc = async (id: string) => {
    const d = await getDocumentContextDescriptor(id)
    if (!d) { setBlockMsg('这份文档不存在或已被删除。'); return }
    setDoc(d); setBlockMsg(null)
  }

  const filtered = useMemo(() => {
    if (!docs) return []
    const q = search.trim().toLowerCase()
    return q ? docs.filter(d => d.fileName.toLowerCase().includes(q)) : docs
  }, [docs, search])

  const toggle = (id: string) => setChecked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  // Selected chapter nodes (in TOC order) from the checked set.
  const selectedNodes = useMemo(() => {
    if (!doc) return []
    const out: ChapterNode[] = []
    const walk = (list: ChapterNode[]) => { for (const n of list) { if (checked.has(n.id) && selectableChapterRange(n)) out.push(n); walk(n.children) } }
    walk(doc.chapters)
    return out
  }, [doc, checked])

  const selection: PdfSelection = useMemo(() => selectedNodes.length ? buildChapterNodesSelection(selectedNodes) : { kind: 'manual', ranges: [] }, [selectedNodes])
  const selectionCount = countPdfRangePages(selection.ranges)
  const wholeCount = doc ? countPdfRangePages([{ startPage: 1, endPage: doc.pageCount }]) : 0
  const wholeBlocked = doc ? exceedsPdfContextHardLimit(doc.pageCount) : false

  const addSelection = (sel: PdfSelection) => {
    const count = countPdfRangePages(sel.ranges)
    if (exceedsPdfContextHardLimit(count)) { setBlockMsg('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页，请缩小章节或页码范围。'); return }
    if (needsPdfContextSoftConfirm(count)) { setConfirming(sel); return }
    finishAdd(sel)
  }
  const addWhole = () => { if (!doc || wholeBlocked) return; addSelection({ kind: 'manual', title: doc.fileName, ranges: [{ startPage: 1, endPage: doc.pageCount }] }) }
  const addSelected = () => { if (selection.ranges.length === 0) { setBlockMsg('请先选择要加入的章节。'); return } addSelection(selection) }
  const finishAdd = (sel: PdfSelection) => { if (doc) onAdd(sel, doc.id, doc.fileName) }
  const addManual = () => {
    const v = validatePdfRange(manualStart, manualEnd, doc ? doc.pageCount : 0)
    if (v) { setManualError(v); return }
    setManualError(null)
    const s = Number(manualStart.trim()), e = Number(manualEnd.trim())
    addSelection({ kind: 'manual', title: pdfRangesText([{ startPage: s, endPage: e }]), ranges: [{ startPage: s, endPage: e }] })
  }

  return (
    <div className={css.overlay} data-testid="doc-context-picker">
      <div className={css.panel}>
        <div className={css.header}>
          {needDocPick ? (
            <span className={css.title}>从文件资料库加入对话</span>
          ) : (
            <button type="button" className={css.back} data-testid="doc-context-back" onClick={() => { setDoc(null); setChecked(new Set()) }}>←</button>
          )}
          <span className={css.subTitle}>{needDocPick ? '' : (doc ? doc.fileName + ' · ' + doc.pageCount + ' 页' : '')}</span>
          <button type="button" className={css.btn} data-testid="doc-context-cancel" onClick={onCancel}>取消</button>
        </div>
        {needDocPick ? (
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
              <button type="button" className={css.tab + (tab === 'toc' ? ' ' + css.tabOn : '')} data-testid="doc-context-tab-toc" onClick={() => setTab('toc')}>目录</button>
              <button type="button" className={css.tab + (tab === 'manual' ? ' ' + css.tabOn : '')} data-testid="doc-context-tab-manual" onClick={() => setTab('manual')}>页码</button>
            </div>
            {tab === 'toc' ? (
              <div className={css.body} data-testid="doc-context-tree">
                <label className={css.whole} data-testid="doc-context-whole">
                  <input type="checkbox" checked={!wholeBlocked && wholeCount > 0 && selectedNodes.length === 0 && countPdfRangePages(selection.ranges) === wholeCount} onChange={addWhole} disabled={wholeBlocked} />
                  <span>整份文档 · {doc.pageCount} 页</span>
                  {wholeBlocked && <span className={css.limitHint}>当前一次最多处理 120 页，请选择章节或页码范围。</span>}
                </label>
                {doc.chapters.length === 0 ? (
                  <div className={css.empty}>这份文档还没有目录。可使用「页码」或「整份文档」（&le;120 页）。</div>
                ) : (
                  <ChapterTreeCheck nodes={doc.chapters} checked={checked} onToggle={toggle} />
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
                {selectedNodes.length > 0 ? (
                  <>已选择：{selectedNodes.map(n => n.title).filter(Boolean).join('、')}<br />{pdfRangesText(selection.ranges)} · 共 {selectionCount} 页</>
                ) : (
                  <>已选择：未选择章节</>
                )}
              </div>
              <div className={css.footerBtns}>
                <button type="button" className={css.btn} data-testid="doc-context-cancel2" onClick={onCancel}>取消</button>
                <button type="button" className={css.btnPrimary} data-testid="doc-context-add" onClick={addSelected}>加入当前对话</button>
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

function ChapterTreeCheck({ nodes, checked, onToggle }: { nodes: ChapterNode[]; checked: Set<string>; onToggle: (id: string) => void }) {
  return (
    <div className={css.tree}>
      {nodes.map(n => {
        const range = selectableChapterRange(n)
        const disabled = !range
        return (
          <div key={n.id}>
            <label className={css.treeRow} data-depth={n.level} data-testid={'doc-context-node-' + n.id} style={{ paddingLeft: (Math.max(n.level, 1) - 1) * 16 + 4 }}>
              <input type="checkbox" data-testid={'doc-context-check-' + n.id} checked={checked.has(n.id)} disabled={disabled} onChange={() => onToggle(n.id)} />
              <span className={css.treeTitle} title={n.title}>{n.title}</span>
              {range ? <span className={css.treeRange}>PDF {range.startPage}–{range.endPage}</span> : <span className={css.treeRange}>无法定位页码</span>}
            </label>
            {n.children.length > 0 && <ChapterTreeCheck nodes={n.children} checked={checked} onToggle={onToggle} />}
          </div>
        )
      })}
    </div>
  )
}
