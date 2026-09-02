// Chapter outline tree selector. Consumes the parsed PdfOutlineResult from
// Stage 3 verbatim (title/depth/children/startPage/endPage/selectable/resolution)
// — no range/hierarchy recomputation here. Renders expand/collapse + select as
// two distinct button actions; a11y: buttons, aria-expanded, real disabled.
import type { PdfOutlineItem } from './pdf-outline'
import css from './pdf-panel.module.css'

type Props = {
  items: PdfOutlineItem[]
  selectedId: string | null
  expandedIds: ReadonlySet<string>
  onSelect: (node: PdfOutlineItem) => void
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
  selectedId: string | null
  expandedIds: ReadonlySet<string>
  onSelect: (node: PdfOutlineItem) => void
  onToggle: (id: string) => void
}

function OutlineRow({ node, depth, selectedId, expandedIds, onSelect, onToggle }: RowProps) {
  // Blank-title parent with children -> promote children (no blank row, keep subtree).
  if (node.title.trim() === '' && node.children.length > 0) {
    return <>{visibleChildren(node).map(c => <OutlineRow key={c.id} node={c} depth={depth} selectedId={selectedId} expandedIds={expandedIds} onSelect={onSelect} onToggle={onToggle} />)}</>
  }
  const hasChildren = node.children.length > 0
  const expanded = expandedIds.has(node.id)
  const selected = selectedId === node.id

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
          <button
            type="button"
            className={css.outlineTitle + (selected ? ' ' + css.outlineSel : '')}
            data-testid={'outline-item-' + node.id}
            aria-pressed={selected}
            onClick={() => onSelect(node)}
          >
            {node.title}
          </button>
        ) : (
          <span className={css.outlineTitle + ' ' + css.outlineDisabled} data-testid={'outline-item-' + node.id}>{node.title}</span>
        )}
        {node.startPage != null && node.endPage != null && (
          <span className={css.outlineRange}>{node.startPage}–{node.endPage}</span>
        )}
      </div>
      {expanded && hasChildren && (
        <div className={css.outlineChildren}>
          {visibleChildren(node).map(c => <OutlineRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId} expandedIds={expandedIds} onSelect={onSelect} onToggle={onToggle} />)}
        </div>
      )}
    </>
  )
}

export function PdfOutlineSelector({ items, selectedId, expandedIds, onSelect, onToggle }: Props) {
  return (
    <div className={css.outlineList} role="tree" aria-label="章节目录">
      {items.map(it => <OutlineRow key={it.id} node={it} depth={0} selectedId={selectedId} expandedIds={expandedIds} onSelect={onSelect} onToggle={onToggle} />)}
    </div>
  )
}