// Chapter outline tree selector (Stage 4: tree; Stage 9.1: multi-select).
// Consumes the parsed PdfOutlineResult verbatim (title/depth/children/
// startPage/endPage/selectable/resolution). Expand/collapse and select are two
// distinct controls: the chevron toggles the tree, a REAL checkbox selects the
// chapter (no aria-pressed simulation). Selecting a parent does not auto-check
// children — the data layer normalizes/dedups the ranges instead.
import type { PdfOutlineItem } from './pdf-outline'
import css from './pdf-panel.module.css'

type Props = {
  items: PdfOutlineItem[]
  selectedIds: ReadonlySet<string>
  expandedIds: ReadonlySet<string>
  onToggleSelect: (node: PdfOutlineItem) => void
  onToggle: (id: string) => void
}

/** Children worth rendering: drop external leaves (url, no kids) and blank leaves. */
function visibleChildren(node: PdfOutlineItem): PdfOutlineItem[] {
  return node.children.filter(c => {
    if (c.resolution === 'external' && c.children.length === 0) return false
    if (c.title.trim() === '' && c.children.length === 0) return false
    return true
  })
}

type RowProps = {
  node: PdfOutlineItem
  depth: number
  selectedIds: ReadonlySet<string>
  expandedIds: ReadonlySet<string>
  onToggleSelect: (node: PdfOutlineItem) => void
  onToggle: (id: string) => void
}

function OutlineRow({ node, depth, selectedIds, expandedIds, onToggleSelect, onToggle }: RowProps) {
  // Blank-title parent with children -> promote children (no blank row, keep subtree).
  if (node.title.trim() === '' && node.children.length > 0) {
    return <>{visibleChildren(node).map(c => <OutlineRow key={c.id} node={c} depth={depth} selectedIds={selectedIds} expandedIds={expandedIds} onToggleSelect={onToggleSelect} onToggle={onToggle} />)}</>
  }
  const hasChildren = node.children.length > 0
  const expanded = expandedIds.has(node.id)
  const selected = selectedIds.has(node.id)

  return (
    <>
      <div className={css.outlineRow} style={{ paddingLeft: depth * 14 }}>
        <button
          type="button"
          className={css.outlineChevron}
          aria-expanded={expanded}
          aria-label={expanded ? '收起' : '展开'}
          data-testid={'outline-toggle-' + node.id}
          disabled={!hasChildren}
          onClick={() => hasChildren && onToggle(node.id)}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : ''}
        </button>
        {node.selectable ? (
          <label
            className={css.outlineTitle + (selected ? ' ' + css.outlineSel : '')}
            data-testid={'outline-item-' + node.id}
          >
            <input
              type="checkbox"
              className={css.outlineCheck}
              checked={selected}
              aria-label={'选择章节 ' + node.title}
              onChange={() => onToggleSelect(node)}
            />
            <span className={css.outlineTitleText}>{node.title}</span>
          </label>
        ) : (
          <span className={css.outlineTitle + ' ' + css.outlineDisabled} data-testid={'outline-item-' + node.id}>{node.title}</span>
        )}
        {node.startPage != null && node.endPage != null && (
          <span className={css.outlineRange}>{node.startPage}–{node.endPage}</span>
        )}
      </div>
      {expanded && hasChildren && (
        <div className={css.outlineChildren}>
          {visibleChildren(node).map(c => <OutlineRow key={c.id} node={c} depth={depth + 1} selectedIds={selectedIds} expandedIds={expandedIds} onToggleSelect={onToggleSelect} onToggle={onToggle} />)}
        </div>
      )}
    </>
  )
}

export function PdfOutlineSelector({ items, selectedIds, expandedIds, onToggleSelect, onToggle }: Props) {
  return (
    <div className={css.outlineList} role="tree" aria-label="章节目录">
      {items.map(it => <OutlineRow key={it.id} node={it} depth={0} selectedIds={selectedIds} expandedIds={expandedIds} onToggleSelect={onToggleSelect} onToggle={onToggle} />)}
    </div>
  )
}
