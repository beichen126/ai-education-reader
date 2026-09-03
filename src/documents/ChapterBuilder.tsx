// Chapter Builder (Stage 9.4A / 9.4A.1): a stable manual chapter-structure editor
// for documents with no native outline (or to maintain existing manual chapters).
// The Reader only opens it, provides currentPage, and consumes the saved tree.
// Editing happens on a LOCAL flat draft; persistence happens ONLY on 保存 and is
// the Reader's responsibility — onSave returns a Promise so this Builder controls
// saving/error/close timing. A failed save NEVER fabricates success: the Builder
// stays open, the draft is preserved, and an explicit error is shown.
import { useEffect, useRef, useState } from 'react'
import type { ChapterNode, DocumentChapterSource } from './document-types'
import {
  validateChapterDraft, buildManualChapterTree, flattenManualChapters,
  cloneChapterDraft, makeNewChapterItem, chapterSourceForTree,
  deleteDraftSubtree, draftHasChildren, indentSubtree, outdentSubtree,
  insertChapterByPage, canApplyChapterDraftOperation,
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
  onSave: (save: ChapterBuilderSave) => Promise<void>
  onClose: () => void
}

const SAVE_FAILED_MSG = '无法保存章节，请检查浏览器存储空间后重试。'
const SAME_PAGE_MSG = '第 {P} 页已有同级章节，请编辑现有章节或调整新章节层级。'

export function ChapterBuilder({ pageCount, initialChapters, currentPage, seedFromCurrentPage, onSave, onClose }: Props) {
  const seedConflictRef = useRef<string | null>(null)
  const [items, setItems] = useState<ChapterDraftItem[]>(() => {
    const base = cloneChapterDraft(flattenManualChapters(initialChapters))
    if (!seedFromCurrentPage) return base
    const item = makeNewChapterItem({ currentPage, pageCount, level: 1 })
    const r = insertChapterByPage(base, item)
    if (r.ok) return r.items
    // A same-page conflict must NOT fabricate an unsavable draft — keep base + note it.
    seedConflictRef.current = SAME_PAGE_MSG.replace('{P}', String(item.startPage))
    return base
  })
  useEffect(() => { if (seedConflictRef.current) { setInsertError(seedConflictRef.current); seedConflictRef.current = null } }, [])
  const [validation, setValidation] = useState<ChapterDraftValidation>({ ok: true, issues: [] })
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [insertError, setInsertError] = useState<string | null>(null)

  // Dirty = any item differs from the persisted draft.
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

  // Both add entrances funnel through the SAME page-aware insertion helper (§9).
  const insertNew = () => {
    setInsertError(null)
    const item = makeNewChapterItem({ currentPage, pageCount, level: 1 })
    setItems(prev => {
      const r = insertChapterByPage(prev, item)
      if (!r.ok) { setInsertError(SAME_PAGE_MSG.replace('{P}', String(item.startPage))); return prev }
      return r.items
    })
  }

  const requestDelete = (index: number) => {
    if (draftHasChildren(items, index)) { setPendingDelete(index); return }
    setItems(prev => deleteDraftSubtree(prev, index))
  }
  const applyOp = (fn: (items: ChapterDraftItem[], index: number) => ChapterDraftItem[], index: number) => {
    setItems(prev => fn(cloneChapterDraft(prev), index))
  }

  const save = async () => {
    if (saving) return
    setSaveError(null)
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
    setSaving(true)
    try {
      await onSave({ chapters: tree, source: chapterSourceForTree(tree) })
      // Success: the Reader's onSave closes this Builder (unmount). No need to reset.
    } catch {
      // A failed save must NOT fabricate success: builder stays open, draft kept.
      setSaving(false)
      setSaveError(SAVE_FAILED_MSG)
    }
  }

  const close = () => {
    if (saving) return
    if (dirty) { setConfirmDiscard(true); return }
    onClose()
  }

  // Keyboard priority: Escape closes (confirm when dirty). Typing / arrows are
  // swallowed by this builder being open (the Reader's keydown is guarded).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (saving) return
      if (confirmDiscard) { setConfirmDiscard(false); return }
      if (pendingDelete != null) { setPendingDelete(null); return }
      if (dirty) { setConfirmDiscard(true); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDiscard, pendingDelete, onClose, saving])

  const childCount = pendingDelete != null ? subtreeCount(items, pendingDelete) : 0
  return (
    <div className={css.overlay} data-testid="chapter-builder">
      <div className={css.panel}>
        <div className={css.header}>
          <span className={css.title}>编辑章节</span>
          <div className={css.headerBtns}>
            <button type="button" className={css.btn} data-testid="cb-cancel" disabled={saving} onClick={close}>取消</button>
            <button type="button" className={css.btnPrimary} data-testid="cb-save" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
        {!validation.ok && <div className={css.error} data-testid="cb-error">{validation.issues[0].message}</div>}
        {saveError && <div className={css.error} data-testid="cb-save-error">{saveError}</div>}
        {insertError && <div className={css.error} data-testid="cb-insert-error">{insertError}</div>}
        <div className={css.list} data-testid="cb-list">
          {items.length === 0 && <div className={css.empty} data-testid="cb-empty">尚无章节，点击下方“添加章节”开始。</div>}
          {items.map((it, i) => (
            <BuilderRow
              key={it.id}
              item={it}
              index={i}
              canIndent={canApplyChapterDraftOperation(items, pageCount, indentSubtree, i)}
              canOutdent={canApplyChapterDraftOperation(items, pageCount, outdentSubtree, i)}
              error={rowErrors[i]}
              onTitle={v => updateItem(i, { title: v })}
              onPage={v => updateItem(i, { startPage: pageFromInput(v) })}
              onIndent={() => applyOp(indentSubtree, i)}
              onOutdent={() => applyOp(outdentSubtree, i)}
              onDelete={() => requestDelete(i)}
            />
          ))}
        </div>
        <div className={css.footer}>
          <div className={css.footerBtns}>
            <button type="button" className={css.btn} data-testid="cb-add" disabled={saving} onClick={insertNew}>+ 添加章节</button>
            <button type="button" className={css.btn} data-testid="cb-add-current" disabled={saving} onClick={insertNew}>从当前页添加：{currentPage || 1}</button>
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

function BuilderRow(props: {
  item: ChapterDraftItem; index: number
  canIndent: boolean; canOutdent: boolean; error?: string
  onTitle: (v: string) => void; onPage: (v: string) => void
  onIndent: () => void; onOutdent: () => void; onDelete: () => void
}) {
  const { item, index, canIndent, canOutdent, error, onTitle, onPage, onIndent, onOutdent, onDelete } = props
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
        <button type="button" className={css.op} data-testid={'cb-outdent-' + index} title="减少缩进" disabled={!canOutdent} onClick={onOutdent}>←</button>
        <button type="button" className={css.op} data-testid={'cb-indent-' + index} title="缩进" disabled={!canIndent} onClick={onIndent}>→</button>
      </div>
      {error && <div className={css.error} data-testid={'cb-row-err-' + index}>{error}</div>}
    </div>
  )
}
