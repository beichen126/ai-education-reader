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
  validateChapterDraft, buildManualChapterTree, buildChapterTreeFromDraft, flattenManualChapters,
  cloneChapterDraft, makeNewChapterItem, chapterSourceForTree,
  deleteDraftSubtree, draftHasChildren, indentSubtree, outdentSubtree,
  moveUp, moveDown,
  insertChapterByPage, canApplyChapterDraftOperation,
  setDraftItemLevel, setDraftItemsLevel, shiftDraftItemsLevel, MAX_CHAPTER_LEVEL,
  type ChapterDraftItem, type ChapterDraftValidation,
} from './chapter-builder'
import css from './chapter-builder.module.css'
import { tx } from '../engine/locale'

export type ChapterBuilderSave = { chapters: ChapterNode[]; source: DocumentChapterSource }

type Props = {
  pageCount: number
  initialChapters: ChapterNode[]
  currentPage: number
  /** Pre-computed editable draft (e.g. from a native outline via chaptersToEditableDraft). */
  draftSeed?: ChapterDraftItem[]
  /** Light note shown above the list (e.g. '正在整理 PDF 原始目录…'). */
  hint?: string
  /** Count of native items that had no resolvable page and were not imported. */
  skippedUnresolved?: number
  /** Provenance for the built tree: 'manual' (native organize / manual edit) or
   *  'ai-toc' (AI review -> edit all; stays ai-toc even after human fixes).
   *  The Reader/UI never guesses. Defaults to 'manual'. */
  saveSource?: 'manual' | 'ai-toc'
  onSave: (save: ChapterBuilderSave) => Promise<void>
  onClose: () => void
}

const saveFailedMsg = () => tx('无法保存章节，请检查浏览器存储空间后重试。', 'Unable to save chapters. Check browser storage and try again.')
const samePageMsg = (page: number) => tx('第 ' + page + ' 页已有同级章节，请编辑现有章节或调整新章节层级。', 'Page ' + page + ' already has a chapter at this level. Edit it or choose another level.')
const insideSubtreeMsg = () => tx('当前页位于已有章节结构内部，请在章节编辑器中调整层级或目录结构。', 'This page is inside an existing chapter tree. Adjust the level or outline structure in the editor.')

function idsBetween(orderedIds: readonly string[], anchorId: string | null, targetId: string): string[] {
  if (!anchorId) return []
  const anchorIndex = orderedIds.indexOf(anchorId)
  const targetIndex = orderedIds.indexOf(targetId)
  if (anchorIndex < 0 || targetIndex < 0) return []
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return orderedIds.slice(start, end + 1)
}

export function ChapterBuilder({ pageCount, initialChapters, currentPage, draftSeed, hint, skippedUnresolved = 0, saveSource = 'manual', onSave, onClose }: Props) {
  const [items, setItems] = useState<ChapterDraftItem[]>(() => {
    // A pre-computed draftSeed (native / ai-toc) wins; otherwise derive from the tree.
    return draftSeed ? cloneChapterDraft(draftSeed) : cloneChapterDraft(flattenManualChapters(initialChapters))
  })
  const [validation, setValidation] = useState<ChapterDraftValidation>({ ok: true, issues: [] })
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [insertError, setInsertError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [bulkError, setBulkError] = useState<string | null>(null)

  // Dirty = any item differs from the persisted draft (baseline matches the seed).
  const originalRef = useRef<ChapterDraftItem[]>(draftSeed ? cloneChapterDraft(draftSeed) : flattenManualChapters(initialChapters))
  const dirty = (() => {
    const orig = originalRef.current
    if (items.length !== orig.length) return true
    return items.some((it, i) => {
      const o = orig[i]
      return !o || o.id !== it.id || o.title !== it.title || o.level !== it.level || o.startPage !== it.startPage
    })
  })()

  useEffect(() => { setValidation(validateChapterDraft(items, pageCount)) }, [items, pageCount])

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
  const visibleEntries = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !normalizedSearch || item.title.toLocaleLowerCase().includes(normalizedSearch))
  const visibleIds = visibleEntries.map(({ item }) => item.id)

  const updateItem = (index: number, patch: Partial<ChapterDraftItem>) => {
    setBulkError(null)
    setItems(prev => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  const updateLevel = (index: number, raw: string) => {
    const level = Number(raw)
    if (!Number.isInteger(level)) return
    setBulkError(null)
    setItems(prev => setDraftItemLevel(prev, index, level))
  }

  const toggleSelection = (id: string, checked: boolean, shiftKey: boolean) => {
    setBulkError(null)
    setSelectedIds(prev => {
      const next = new Set(prev)
      const range = shiftKey ? idsBetween(visibleIds, selectionAnchorId, id) : []
      for (const rangeId of range) {
        if (checked) next.add(rangeId)
        else next.delete(rangeId)
      }
      if (range.length === 0) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
    setSelectionAnchorId(id)
  }

  const selectAll = () => {
    setBulkError(null)
    setSelectedIds(new Set(visibleIds))
    setSelectionAnchorId(visibleIds.length > 0 ? visibleIds[visibleIds.length - 1] : null)
  }

  const selectCurrentLevel = (level: number) => {
    setBulkError(null)
    const ids = visibleEntries.filter(({ item }) => item.level === level).map(({ item }) => item.id)
    setSelectedIds(new Set(ids))
    setSelectionAnchorId(ids.length > 0 ? ids[ids.length - 1] : null)
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
    setSelectionAnchorId(null)
    setBulkError(null)
  }

  const applyBulkLevel = (level: number) => {
    setBulkError(null)
    setItems(setDraftItemsLevel(items, selectedIds, level))
  }

  const applyBulkShift = (delta: number) => {
    const result = shiftDraftItemsLevel(items, selectedIds, delta)
    if (result.ok === false) {
      const item = items.find(candidate => candidate.id === result.itemId)
      setBulkError(tx('批量操作未执行：「' + (item?.title || '未命名章节') + '」不能调整到 L' + result.toLevel + '，本批次未修改。', 'Bulk change was not applied: “' + (item?.title || 'Untitled chapter') + '” cannot move to L' + result.toLevel + '.'))
      return
    }
    setBulkError(null)
    setItems(result.items)
  }

  // Both add entrances funnel through the SAME page-aware insertion helper (§9).
  const insertNew = () => {
    setInsertError(null)
    const item = makeNewChapterItem({ currentPage, pageCount, level: 1 })
    setItems(prev => {
      const r = insertChapterByPage(prev, item)
      if (!r.ok) { setInsertError(('reason' in r && r.reason === 'inside-existing-subtree') ? insideSubtreeMsg() : samePageMsg(item.startPage)); return prev }
      return r.items
    })
  }

  const requestDelete = (index: number) => {
    // v1.1.3: there is no undo, so EVERY delete (leaf OR parent) must be explicitly confirmed.
    // A leaf delete is just as destructive as a parent delete (the row is gone for good).
    setPendingDelete(index)
  }
  const applyOp = (fn: (items: ChapterDraftItem[], index: number) => ChapterDraftItem[], index: number) => {
    setBulkError(null)
    setItems(prev => fn(cloneChapterDraft(prev), index))
  }

  const confirmDeleteDraft = (index: number) => {
    const level = items[index]?.level
    if (level == null) return
    const removedIds = new Set<string>()
    for (let i = index; i < items.length && (i === index || items[i].level > level); i++) removedIds.add(items[i].id)
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const id of removedIds) next.delete(id)
      return next
    })
    setSelectionAnchorId(prev => (prev && removedIds.has(prev) ? null : prev))
    setItems(prev => deleteDraftSubtree(prev, index))
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
    // Empty tree -> 'none' (canonical cleared state); otherwise the caller's provenance.
    const tree = buildChapterTreeFromDraft(items, pageCount, saveSource)
    setSaving(true)
    try {
      await onSave({ chapters: tree, source: tree.length === 0 ? 'none' : saveSource })
      // Success: the Reader's onSave closes this Builder (unmount). No need to reset.
    } catch {
      // A failed save must NOT fabricate success: builder stays open, draft kept.
      setSaving(false)
      setSaveError(saveFailedMsg())
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
      if (selectedIds.size > 0) { setSelectedIds(new Set()); setSelectionAnchorId(null); setBulkError(null); return }
      if (dirty) { setConfirmDiscard(true); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDiscard, pendingDelete, onClose, saving, selectedIds])

  const delIndex = pendingDelete
  const delItem = delIndex != null ? items[delIndex] : null
  const delTitle = delItem?.title?.trim() || tx('（未命名）', '(Untitled)')
  const delHasChildren = delIndex != null ? draftHasChildren(items, delIndex) : false
  const delCount = delIndex != null ? subtreeCount(items, delIndex) : 0
  return (
    <div className={css.overlay} data-testid="chapter-builder">
      <div className={css.panel}>
        <div className={css.header}>
          <span className={css.title}>{tx('编辑章节', 'Edit chapters')}</span>
          <div className={css.headerBtns}>
            <button type="button" className={css.btn} data-testid="cb-cancel" disabled={saving} onClick={close}>{tx('取消', 'Cancel')}</button>
            <button type="button" className={css.btnPrimary} data-testid="cb-save" disabled={saving} onClick={save}>{saving ? tx('保存中…', 'Saving…') : tx('保存', 'Save')}</button>
          </div>
        </div>
        {!validation.ok && <div className={css.error} data-testid="cb-error">{validation.issues[0].message}</div>}
        {saveError && <div className={css.error} data-testid="cb-save-error">{saveError}</div>}
        {insertError && <div className={css.error} data-testid="cb-insert-error">{insertError}</div>}
        {hint && <div className={css.hint} data-testid="cb-hint">{hint}</div>}
        {skippedUnresolved > 0 && <div className={css.warn} data-testid="cb-skipped">{tx('原目录中有 ' + skippedUnresolved + ' 项无法定位页码，未自动加入编辑结果。', skippedUnresolved + ' original outline items had no page mapping and were not added.')}</div>}
        <div className={css.searchRow}>
          <input
            className={css.searchInput}
            data-testid="cb-search"
            type="search"
            placeholder={tx('搜索章节标题…', 'Search chapter titles…')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          <span className={css.searchCount} data-testid="cb-visible-count">
            {normalizedSearch ? tx(`显示 ${visibleEntries.length} / ${items.length}`, `Showing ${visibleEntries.length} / ${items.length}`) : tx(`共 ${items.length} 项`, `${items.length} items`)}
          </span>
        </div>
        <div className={css.list} data-testid="cb-list">
          <div className={css.bulkToolbar} data-testid="cb-bulk-toolbar">
            <div className={css.bulkSummary}>
              <span data-testid="cb-selected-count">{tx('已选 ' + selectedIds.size + ' 项', selectedIds.size + ' selected')}</span>
              <button type="button" className={css.bulkBtn} data-testid="cb-clear-selection" onClick={clearSelection}>{tx('清除选择', 'Clear selection')}</button>
            </div>
            <div className={css.bulkGroup}>
              <span className={css.bulkLabel}>{tx('选择当前：', 'Select:')}</span>
              <button type="button" className={css.bulkBtn} data-testid="cb-select-all" onClick={selectAll}>{normalizedSearch ? tx('全选当前结果', 'Select all results') : tx('全选', 'Select all')}</button>
              {Array.from({ length: MAX_CHAPTER_LEVEL }, (_, level) => (
                <button type="button" className={css.bulkBtn} data-testid={'cb-select-level-' + (level + 1)} key={level + 1} onClick={() => selectCurrentLevel(level + 1)}>L{level + 1}</button>
              ))}
            </div>
            <div className={css.bulkGroup}>
              <span className={css.bulkLabel}>{tx('设为：', 'Set to:')}</span>
              {Array.from({ length: MAX_CHAPTER_LEVEL }, (_, level) => (
                <button type="button" className={css.bulkBtn} data-testid={'cb-bulk-set-' + (level + 1)} key={level + 1} disabled={selectedIds.size === 0} onClick={() => applyBulkLevel(level + 1)}>L{level + 1}</button>
              ))}
            </div>
            <div className={css.bulkGroup}>
              <button type="button" className={css.bulkBtn} data-testid="cb-bulk-outdent" disabled={selectedIds.size === 0} onClick={() => applyBulkShift(-1)}>{tx('减少一级', 'Decrease level')}</button>
              <button type="button" className={css.bulkBtn} data-testid="cb-bulk-indent" disabled={selectedIds.size === 0} onClick={() => applyBulkShift(1)}>{tx('增加一级', 'Increase level')}</button>
            </div>
            {bulkError && <div className={css.bulkError} data-testid="cb-bulk-error">{bulkError}</div>}
          </div>
          {items.length === 0 && <div className={css.empty} data-testid="cb-empty">{tx('尚无章节，点击下方“从 PDF 第 ' + (currentPage || 1) + ' 页新建章节”开始。', 'No chapters yet. Create one from PDF page ' + (currentPage || 1) + ' below.')}</div>}
          {items.length > 0 && visibleEntries.length === 0 && <div className={css.empty} data-testid="cb-no-results">{tx('没有匹配的章节。', 'No matching chapters.')}</div>}
          {visibleEntries.map(({ item: it, index: i }) => (
            <BuilderRow
              key={it.id}
              item={it}
              index={i}
              selected={selectedIds.has(it.id)}
              canUp={canApplyChapterDraftOperation(items, pageCount, moveUp, i)}
              canDown={canApplyChapterDraftOperation(items, pageCount, moveDown, i)}
              canIndent={canApplyChapterDraftOperation(items, pageCount, indentSubtree, i)}
              canOutdent={canApplyChapterDraftOperation(items, pageCount, outdentSubtree, i)}
              error={rowErrors[i]}
              onSelect={(checked, shiftKey) => toggleSelection(it.id, checked, shiftKey)}
              onTitle={v => updateItem(i, { title: v })}
              onPage={v => updateItem(i, { startPage: pageFromInput(v) })}
              onLevel={v => updateLevel(i, v)}
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
            <button type="button" className={css.btn} data-testid="cb-add" disabled={saving} onClick={insertNew}>+ {tx('从 PDF 第 ' + (currentPage || 1) + ' 页新建章节', 'Create chapter from PDF page ' + (currentPage || 1))}</button>
          </div>
        </div>
      </div>
      {pendingDelete != null && (
        <div className={css.confirm} data-testid="cb-confirm">
          <div className={css.confirmBox}>
            <div>{delHasChildren ? tx('确认删除「' + delTitle + '」及其 ' + delCount + ' 个子章节？', 'Delete “' + delTitle + '” and its ' + delCount + ' subchapters?') : tx('确认删除「' + delTitle + '」？', 'Delete “' + delTitle + '”?')}</div>
            <div className={css.confirmBtns}>
              <button type="button" className={css.btn} data-testid="cb-confirm-no" onClick={() => setPendingDelete(null)}>{tx('取消', 'Cancel')}</button>
              <button type="button" className={css.btnPrimary} data-testid="cb-confirm-yes" onClick={() => { const idx = pendingDelete; setPendingDelete(null); confirmDeleteDraft(idx) }}>{tx('确认删除', 'Delete')}</button>
            </div>
          </div>
        </div>
      )}
      {confirmDiscard && (
        <div className={css.confirm} data-testid="cb-discard-confirm">
          <div className={css.confirmBox}>
            <div>{tx('放弃未保存的章节修改？', 'Discard unsaved chapter changes?')}</div>
            <div className={css.confirmBtns}>
              <button type="button" className={css.btn} data-testid="cb-discard-no" onClick={() => setConfirmDiscard(false)}>{tx('继续编辑', 'Continue editing')}</button>
              <button type="button" className={css.btnPrimary} data-testid="cb-discard-yes" onClick={onClose}>{tx('放弃修改', 'Discard changes')}</button>
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
  item: ChapterDraftItem; index: number; selected: boolean
  canUp: boolean; canDown: boolean; canIndent: boolean; canOutdent: boolean; error?: string
  onSelect: (checked: boolean, shiftKey: boolean) => void; onTitle: (v: string) => void; onPage: (v: string) => void; onLevel: (v: string) => void
  onUp: () => void; onDown: () => void; onIndent: () => void; onOutdent: () => void; onDelete: () => void
}) {
  const { item, index, selected, canUp, canDown, canIndent, canOutdent, error, onSelect, onTitle, onPage, onLevel, onUp, onDown, onIndent, onOutdent, onDelete } = props
  const pad = (item.level - 1) * 14
  return (
    <div className={css.row + (error ? ' ' + css.rowErr : '')} data-testid="cb-row">
      <div className={css.indentSpacer} style={{ width: pad }} aria-hidden />
      <div className={css.rowTop}>
        <input type="checkbox" className={css.selectionCheckbox} data-testid={'cb-select-' + index} aria-label={tx('选择第 ' + (index + 1) + ' 项', 'Select item ' + (index + 1))} checked={selected} onChange={e => onSelect(e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)} />
        <select
          className={css.levelSelect}
          data-testid={'cb-level-' + index}
          aria-label={tx('第 ' + (index + 1) + ' 项层级', 'Level for item ' + (index + 1))}
          title={tx('选择章节层级', 'Choose chapter level')}
          value={String(item.level)}
          onChange={e => onLevel(e.target.value)}
        >
          {Array.from({ length: MAX_CHAPTER_LEVEL }, (_, level) => (
            <option key={level + 1} value={String(level + 1)}>L{level + 1}</option>
          ))}
        </select>
        <input className={css.titleInput} data-testid={'cb-title-' + index} value={item.title} placeholder={tx('章节标题', 'Chapter title')} onChange={e => onTitle(e.target.value)} />
        <input className={css.pageInput} data-testid={'cb-page-' + index} inputMode="numeric" value={String(item.startPage)} onChange={e => onPage(e.target.value)} />
      </div>
      <div className={css.rowOps}>
        <button type="button" className={css.op} data-testid={'cb-up-' + index} title={tx('上移', 'Move up')} disabled={!canUp} onClick={onUp}>↑</button>
        <button type="button" className={css.op} data-testid={'cb-down-' + index} title={tx('下移', 'Move down')} disabled={!canDown} onClick={onDown}>↓</button>
        <button type="button" className={css.op} data-testid={'cb-outdent-' + index} title={tx('减少缩进', 'Outdent')} disabled={!canOutdent} onClick={onOutdent}>←</button>
        <button type="button" className={css.op} data-testid={'cb-indent-' + index} title={tx('缩进', 'Indent')} disabled={!canIndent} onClick={onIndent}>→</button>
        <button type="button" className={css.op + ' ' + css.opDel} data-testid={'cb-del-' + index} title={tx('删除', 'Delete')} onClick={onDelete}>{tx('删除', 'Delete')}</button>
      </div>
      {error && <div className={css.error} data-testid={'cb-row-err-' + index}>{error}</div>}
    </div>
  )
}
