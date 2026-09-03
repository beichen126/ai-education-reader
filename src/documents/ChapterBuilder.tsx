// Chapter Builder (Stage 9.4A): a stable manual chapter-structure editor for
// documents with no native outline (or to maintain existing manual chapters).
// The Reader only opens it, provides currentPage, and consumes the saved tree.
// Editing happens on a LOCAL flat draft; nothing is persisted until 保存, and
// the Reader refreshes the tree from the saved result (never re-opened).
import { useEffect, useRef, useState } from 'react'
import type { ChapterNode, DocumentChapterSource } from './document-types'
import {
  validateChapterDraft, buildManualChapterTree, flattenManualChapters,
  cloneChapterDraft, makeNewChapterItem, chapterSourceForTree,
  deleteDraftSubtree, draftHasChildren, moveUp, moveDown, indentSubtree, outdentSubtree,
  type ChapterDraftItem, type ChapterDraftValidation,
} from './chapter-builder'
import css from './chapter-builder.module.css'

export type ChapterBuilderSave = { chapters: ChapterNode[]; source: DocumentChapterSource }

type Props = {
  pageCount: number
  initialChapters: ChapterNode[]
  currentPage: number
  /** When opened via 从此页新建章节, pre-seed ONE new row at currentPage. */
  seedFromCurrentPage?: boolean
  onSave: (save: ChapterBuilderSave) => void
  onClose: () => void
}

export function ChapterBuilder({ pageCount, initialChapters, currentPage, seedFromCurrentPage, onSave, onClose }: Props) {
  const [items, setItems] = useState<ChapterDraftItem[]>(() => {
    const base = cloneChapterDraft(flattenManualChapters(initialChapters))
    if (seedFromCurrentPage) base.push(makeNewChapterItem({ currentPage, pageCount, level: 1 }))
    return base
  })
  const [validation, setValidation] = useState<ChapterDraftValidation>({ ok: true, issues: [] })
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  // Dirty = any item differs from the persisted draft (by id/title/level/startPage).
  const originalRef = useRef<ChapterDraftItem[]>(flattenManualChapters(initialChapters))
  const dirty = (() => {
    const orig = originalRef.current
    if (items.length !== orig.length) return true
    return items.some((it, i) => {
      const o = orig[i]
      return !o || o.id !== it.id || o.title !== it.title || o.level !== it.level || o.startPage !== it.startPage
    })
  })()

  useEffect(() => { setValidation(validateChapterDraft(items, pageCount)) }, [items, pageCount])

  const updateItem = (index: number, patch: Partial<ChapterDraftItem>) => {
    setItems(prev => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }
  const addItem = () => {
    const item = makeNewChapterItem({ currentPage, pageCount, level: 1 })
    setItems(prev => [...prev, item])
  }
  const addFromCurrentPage = () => {
    const item = makeNewChapterItem({ currentPage, pageCount, level: 1 })
    setItems(prev => [...prev, item])
  }
  const requestDelete = (index: number) => {
    if (draftHasChildren(items, index)) {
      // Deletion of a parent always cascades to its subtree — require confirmation.
      setPendingDelete(index)
      return
    }
    setItems(prev => deleteDraftSubtree(prev, index))
  }
  const applyOp = (fn: (items: ChapterDraftItem[], index: number) => ChapterDraftItem[], index: number) => {
    setItems(prev => fn(cloneChapterDraft(prev), index))
  }

  const save = () => {
    const v = validateChapterDraft(items, pageCount)
    setValidation(v)
    if (!v.ok) {
      const errMap: Record<number, string> = {}
      for (const issue of v.issues) if (!errMap[issue.index]) errMap[issue.index] = issue.message
      setRowErrors(errMap)
      return
    }
    setRowErrors({})
    const tree = buildManualChapterTree(items, pageCount)
    onSave({ chapters: tree, source: chapterSourceForTree(tree) })
  }

  const close = () => {
    if (dirty) { setConfirmDiscard(true); return }
    onClose()
  }

  // Keyboard priority: Escape closes (confirm when dirty). Typing / arrows are
  // swallowed by this builder being open (the Reader's keydown is guarded).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (confirmDiscard) { setConfirmDiscard(false); return }
      if (pendingDelete != null) { setPendingDelete(null); return }
      if (dirty) { setConfirmDiscard(true); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDiscard, pendingDelete, onClose])

  const childCount = pendingDelete != null ? subtreeCount(items, pendingDelete) : 0
  return (
    <div className={css.overlay} data-testid="chapter-builder">
      <div className={css.panel}>
        <div className={css.header}>
          <span className={css.title}>编辑章节</span>
          <div className={css.headerBtns}>
            <button type="button" className={css.btn} data-testid="cb-cancel" onClick={close}>取消</button>
            <button type="button" className={css.btnPrimary} data-testid="cb-save" onClick={save}>保存</button>
          </div>
        </div>
        {!validation.ok && <div className={css.error} data-testid="cb-error">{validation.issues[0].message}</div>}
        <div className={css.list} data-testid="cb-list">
          {items.length === 0 && <div className={css.empty} data-testid="cb-empty">尚无章节，点击下方“添加章节”开始。</div>}
          {items.map((it, i) => (
            <BuilderRow
              key={it.id}
              item={it}
              index={i}
              hasChildren={draftHasChildren(items, i)}
              canUp={canMoveUp(items, i)}
              canDown={canMoveDown(items, i)}
              canIndent={canIndent(items, i)}
              canOutdent={it.level > 1}
              error={rowErrors[i]}
              onTitle={v => updateItem(i, { title: v })}
              onPage={v => updateItem(i, { startPage: pageFromInput(v) })}
              onUp={() => applyOp(moveUp, i)}
              onDown={() => applyOp(moveDown, i)}
              onIndent={() => applyOp(indentSubtree, i)}
              onOutdent={() => applyOp(outdentSubtree, i)}
              onDelete={() => requestDelete(i)}
            />
          ))}
        </div>
        <div className={css.footer}>
          <div className={css.footerBtns}>
            <button type="button" className={css.btn} data-testid="cb-add" onClick={addItem}>+ 添加章节</button>
            <button type="button" className={css.btn} data-testid="cb-add-current" onClick={addFromCurrentPage}>从当前页添加：{currentPage || 1}</button>
          </div>
        </div>
      </div>
      {pendingDelete != null && (
        <div className={css.confirm} data-testid="cb-confirm">
          <div className={css.confirmBox}>
            <div>删除该章节将同时删除其下属 {childCount} 个子章节。确认删除？</div>
            <div className={css.confirmBtns}>
              <button type="button" className={css.btn} data-testid="cb-confirm-no" onClick={() => setPendingDelete(null)}>取消</button>
              <button type="button" className={css.btnPrimary} data-testid="cb-confirm-yes" onClick={() => { const idx = pendingDelete; setPendingDelete(null); setItems(prev => deleteDraftSubtree(prev, idx)); }}>确认删除</button>
            </div>
          </div>
        </div>
      )}
      {confirmDiscard && (
        <div className={css.confirm} data-testid="cb-discard-confirm">
          <div className={css.confirmBox}>
            <div>放弃未保存的章节修改？</div>
            <div className={css.confirmBtns}>
              <button type="button" className={css.btn} data-testid="cb-discard-no" onClick={() => setConfirmDiscard(false)}>继续编辑</button>
              <button type="button" className={css.btnPrimary} data-testid="cb-discard-yes" onClick={onClose}>放弃修改</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- pure helpers ----

/** Parse a page input: keep the raw number for live editing; integer-ify when integer. */
export function pageFromInput(v: string): number {
  const n = Number(v.trim())
  return Number.isInteger(n) ? n : n
}

function subtreeCount(items: ChapterDraftItem[], index: number): number {
  if (index < 0 || index >= items.length) return 0
  const level = items[index].level
  let n = 0
  for (let k = index + 1; k < items.length && items[k].level > level; k++) n++
  return n
}

function canMoveUp(items: ChapterDraftItem[], index: number): boolean {
  if (index <= 0) return false
  const level = items[index].level
  let k = index - 1
  while (k >= 0 && items[k].level > level) k--
  return k >= 0 && items[k].level === level
}
function canMoveDown(items: ChapterDraftItem[], index: number): boolean {
  const level = items[index].level
  let k = index + 1
  while (k < items.length && items[k].level > level) k++
  return k < items.length && items[k].level === level
}
function canIndent(items: ChapterDraftItem[], index: number): boolean {
  if (index <= 0) return false
  const level = items[index].level
  let k = index - 1
  while (k >= 0 && items[k].level > level) k--
  return k >= 0 && items[k].level === level
}

function BuilderRow(props: {
  item: ChapterDraftItem; index: number; hasChildren: boolean
  canUp: boolean; canDown: boolean; canIndent: boolean; canOutdent: boolean; error?: string
  onTitle: (v: string) => void; onPage: (v: string) => void
  onUp: () => void; onDown: () => void; onIndent: () => void; onOutdent: () => void; onDelete: () => void
}) {
  const { item, index, hasChildren, canUp, canDown, canIndent, canOutdent, error, onTitle, onPage, onUp, onDown, onIndent, onOutdent, onDelete } = props
  const pad = (item.level - 1) * 14
  return (
    <div className={css.row + (error ? ' ' + css.rowErr : '')} data-testid="cb-row">
      <div className={css.indentSpacer} style={{ width: pad }} aria-hidden />
      <div className={css.rowTop}>
        <span className={css.levelDim} data-testid="cb-level">L{item.level}</span>
        <input className={css.titleInput} data-testid={'cb-title-' + index} value={item.title} placeholder="章节标题" onChange={e => onTitle(e.target.value)} />
        <input className={css.pageInput} data-testid={'cb-page-' + index} inputMode="numeric" value={String(item.startPage)} onChange={e => onPage(e.target.value)} />
      </div>
      <div className={css.rowOps}>
        <button type="button" className={css.op + ' ' + css.opDanger} data-testid={'cb-del-' + index} title="删除" onClick={onDelete}>×</button>
        <button type="button" className={css.op} data-testid={'cb-up-' + index} title="上移" disabled={!canUp} onClick={onUp}>↑</button>
        <button type="button" className={css.op} data-testid={'cb-down-' + index} title="下移" disabled={!canDown} onClick={onDown}>↓</button>
        <button type="button" className={css.op} data-testid={'cb-outdent-' + index} title="减少缩进" disabled={!canOutdent} onClick={onOutdent}>←</button>
        <button type="button" className={css.op} data-testid={'cb-indent-' + index} title="缩进" disabled={!canIndent} onClick={onIndent}>→</button>
      </div>
      {error && <div className={css.error} data-testid={'cb-row-err-' + index}>{error}</div>}
    </div>
  )
}
