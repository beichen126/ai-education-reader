

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
    if (selectedNodes.length) return buildChapterNodesSelection(selectedNodes)
    return { kind: 'manual', ranges: [] }
  }, [wholeChecked, manualSel, selectedNodes, doc])

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

  const commit = () => {
    if (!hasScope) { setBlockMsg('请先选择要加入的章节或页码范围。'); return }
    const count = countPdfRangePages(selection.ranges)
    if (exceedsPdfContextHardLimit(count)) { setBlockMsg('当前一次最多处理 ' + MAX_PDF_CONTEXT_PAGES + ' 页，请缩小章节或页码范围。'); return }
    if (needsPdfContextSoftConfirm(count)) { setConfirming(selection); return }
    finishAdd(selection)
  }
  const finishAdd = (sel: PdfSelection) => { if (doc) onAdd(sel, doc.id, doc.fileName) }

  return (
    <div className={css.overlay} data-testid="doc-context-picker">
      <div className={css.panel}>
        <div className={css.header}>
          {stage === 'context' && !scoped && (
            <button type="button" className={css.back} data-testid="doc-context-back" onClick={backToDocs}>←</button>
          )}
          <span className={css.title}>{stage === 'document' ? '从文件资料库加入对话' : (doc ? doc.fileName : '')}</span>
          <span className={css.subTitle}>{stage === 'context' && doc ? doc.pageCount + ' 页' : ''}</span>
          <button type="button" className={css.btn} data-testid="doc-context-cancel" onClick={onCancel}>取消</button>
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
                {hasScope ? (
                  <>{selection.title ? '已选择：' + selection.title : '已选择：' + (wholeChecked ? '整份文档' : pdfRangesText(selection.ranges))}<br />{pdfRangesText(selection.ranges)} · 共 {selectionCount} 页</>
                ) : (
                  <>已选择：未选择章节</>
                )}
              </div>
              <div className={css.footerBtns}>
                <button type="button" className={css.btn} data-testid="doc-context-cancel2" onClick={onCancel}>取消</button>
                <button type="button" className={css.btnPrimary} data-testid="doc-context-add" onClick={commit}>加入当前对话</button>
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
