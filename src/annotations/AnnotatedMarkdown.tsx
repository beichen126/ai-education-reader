import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { MarkdownBlocks } from '../markdown/MarkdownBlocks'
import { parseMarkdown } from '../markdown/parse'
import { mapSelection } from './selection-mapper'
import { resolveToRange, resolveByExact } from './range-resolver'
import { buildBlockMapFromRoot } from './canonical'
import { useMessageAnnotations, toggleMessageSelection, toggleTableCellsMessage, toggleWholeTableMessage, toggleMathMessage, refreshMessageAnnotations } from './annotation-store'
import { setMessageRanges, removeMessageRanges, highlightSupported } from './highlight-registry'
import { shouldToggleAll, normalizeBounds, hasExactRectangle, hasWholeTable, hasMath } from './annotation-ops'
import { containsNode, ownedMath } from './ownership'
import type { SelectionMapping } from './selection-types'
import { markdownSourceForRange } from '../markdown/source-copy'
import css from './annotate.module.css'
import { tx } from '../engine/locale'

type AnnotationEventOwner = {
  element: HTMLElement
  pointerDown(event: Event): void
  selectionEnd(): void
  copy(event: ClipboardEvent): void
}

const eventOwners = new Map<string, AnnotationEventOwner>()
let activeEventOwner: string | null = null
let annotationEventsInstalled = false

function eventOwnerForNode(node: Node | null): [string, AnnotationEventOwner] | null {
  const element = node instanceof Element ? node : node?.parentElement
  const root = element?.closest<HTMLElement>('[data-annotation-owner]')
  if (!root) return null
  const id = root.dataset.annotationOwner
  const owner = id ? eventOwners.get(id) : undefined
  return id && owner ? [id, owner] : null
}

function eventOwnerForSelection(): [string, AnnotationEventOwner] | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const start = eventOwnerForNode(range.startContainer)
  const end = eventOwnerForNode(range.endContainer)
  return start && end && start[0] === end[0] ? start : null
}

const delegatedPointerDown = (event: Event) => {
  const found = eventOwnerForNode(event.target as Node | null)
  activeEventOwner = found?.[0] ?? null
  found?.[1].pointerDown(event)
}
const delegatedSelectionEnd = () => {
  const found = eventOwnerForSelection()
  if (found) { activeEventOwner = found[0]; found[1].selectionEnd(); return }
  if (activeEventOwner) eventOwners.get(activeEventOwner)?.selectionEnd()
}
const delegatedCopy = (event: ClipboardEvent) => { eventOwnerForSelection()?.[1].copy(event) }

function installAnnotationEvents(): void {
  if (annotationEventsInstalled || typeof document === 'undefined') return
  annotationEventsInstalled = true
  document.addEventListener('selectionchange', delegatedSelectionEnd)
  document.addEventListener('pointerdown', delegatedPointerDown)
  document.addEventListener('pointerup', delegatedSelectionEnd)
  document.addEventListener('touchend', delegatedSelectionEnd)
  document.addEventListener('copy', delegatedCopy)
}

function uninstallAnnotationEventsIfIdle(): void {
  if (!annotationEventsInstalled || eventOwners.size > 0 || typeof document === 'undefined') return
  annotationEventsInstalled = false
  activeEventOwner = null
  document.removeEventListener('selectionchange', delegatedSelectionEnd)
  document.removeEventListener('pointerdown', delegatedPointerDown)
  document.removeEventListener('pointerup', delegatedSelectionEnd)
  document.removeEventListener('touchend', delegatedSelectionEnd)
  document.removeEventListener('copy', delegatedCopy)
}

export function AnnotatedMarkdown({ content, messageId, conversationId, branchId }: { content: string; messageId: string; conversationId: string; branchId?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const highlightOwnerId = messageId + ':' + useId()
  const [pending, setPending] = useState<SelectionMapping | null>(null)
  const annotations = useMessageAnnotations(conversationId, messageId)
  const parsedRoot = useMemo(() => parseMarkdown(content), [content])
  const { blocks, canonicalOf } = useMemo(() => buildBlockMapFromRoot(parsedRoot, messageId), [parsedRoot, messageId])
  const hasHl = highlightSupported()
  useEffect(() => { void refreshMessageAnnotations(conversationId, messageId) }, [conversationId, messageId])

  useEffect(() => {
    const msgEl = wrapRef.current?.querySelector('[data-message-id]')
    if (!msgEl) return
    let ranges: Range[] = []
    try {
      ranges = annotations.filter((a) => a.target.type === 'text').map((a) => {
        const t = a.target as any
        const r = resolveToRange(msgEl, messageId, t)
        const exact = t.quote && typeof t.quote.exact === 'string' ? t.quote.exact : undefined
        if (r && (!exact || r.toString() === exact)) return r
        // Stale offset (re-parsed content): re-anchor to the stored exact text.
        try { const byExact = resolveByExact(msgEl, messageId, exact); if (byExact) return byExact } catch {}
        return r
      }).filter((r): r is Range => !!r)
    } catch { ranges = [] }
    try { setMessageRanges(highlightOwnerId, ranges) } catch { /* never crash the app on a bad highlight range */ }
    return () => { try { removeMessageRanges(highlightOwnerId) } catch {} }
  }, [annotations, messageId, content, hasHl, highlightOwnerId])

  useEffect(() => {
    let pressedMath: { id: string; kind: 'inline' | 'block' } | null = null
    function onPointerDown(e: Event) {
      // Ownership guard: only the instance whose wrapper contains the target may
      // register a math press. A formula in ANOTHER message must never put this
      // instance into pending-math.
      pressedMath = ownedMath(wrapRef.current, e.target as any)
    }
    function onSelChange() {
      const sel = window.getSelection()
      // Math click: pointerup landed on a formula inside THIS message (guarded by
      // ownedMath in onPointerDown). Only the owning instance may enter pending-math.
      if (pressedMath) { setPending({ kind: 'math', mathId: pressedMath.id, mathKind: pressedMath.kind }); pressedMath = null; return }
      if (!sel || sel.rangeCount === 0) { setPending(null); return }
      if (sel.isCollapsed) { setPending(null); return }
      const range = sel.getRangeAt(0)
      // Ownership: only respond to a selection ENTIRELY inside this message. A
      // selection or formula in another message must never drive this instance.
      if (!containsNode(wrapRef.current, range.startContainer) || !containsNode(wrapRef.current, range.endContainer)) { setPending(null); return }
      const msgEl = wrapRef.current?.querySelector('[data-message-id]')
      if (!msgEl) { setPending(null); return }
      try {
        const mStart = ownedMath(wrapRef.current, range.startContainer as any)
        const mEnd = ownedMath(wrapRef.current, range.endContainer as any)
        if (mStart && mEnd && mStart.id === mEnd.id) { setPending({ kind: 'math', mathId: mStart.id, mathKind: mStart.kind }); return }
        // A selection that crosses inline math now falls through to mapSelection: the
        // atomic math unit keeps text offsets aligned, so the passage (including a
        // formula) is markable as one text annotation instead of the bar vanishing.
        const result = mapSelection(msgEl, messageId, range, (b) => blocks.get(b))
        if (result.kind === 'text' && result.segments.length) { setPending(result) }
        else if (result.kind === 'table-cross-cell') { setPending(result) }
        else { setPending(result) }
      } catch { setPending(null) }
    }
    function onCopy(event: ClipboardEvent) {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) return
      const range = selection.getRangeAt(0)
      if (!containsNode(wrapRef.current, range.startContainer) || !containsNode(wrapRef.current, range.endContainer)) return
      const messageRoot = wrapRef.current?.querySelector<HTMLElement>('[data-message-id]')
      if (!messageRoot) return
      const source = markdownSourceForRange(messageRoot, content, range)
      if (source === null) return
      try {
        event.clipboardData.setData('text/plain', source)
        // Chromium and Firefox accept this richer flavor; older WebKit may not.
        // Plain text already contains the source and remains the compatibility path.
        try { event.clipboardData.setData('text/markdown', source) } catch {}
        event.preventDefault()
      } catch { /* keep the browser's normal rendered-text copy when clipboardData is read-only */ }
    }
    const element = wrapRef.current
    if (!element) return
    eventOwners.set(highlightOwnerId, { element, pointerDown: onPointerDown, selectionEnd: onSelChange, copy: onCopy })
    installAnnotationEvents()
    return () => {
      eventOwners.delete(highlightOwnerId)
      if (activeEventOwner === highlightOwnerId) activeEventOwner = null
      uninstallAnnotationEventsIfIdle()
    }
  }, [messageId, content, canonicalOf, highlightOwnerId])

  const markCrossCell = () => { if (!pending || pending.kind !== 'table-cross-cell') return; const a = pending.startCell, b = pending.endCell; const bounds = normalizeBounds(a.row, a.column, b.row, b.column); void toggleTableCellsMessage(conversationId, messageId, pending.tableId, bounds, branchId); window.getSelection()?.removeAllRanges(); setPending(null) }
  const onMathAction = (mathId: string, kind: 'inline' | 'block') => { setPending({ kind: 'math', mathId, mathKind: kind }) }
  function doToggle() {
    try {
    if (!pending) return
    if (pending.kind === 'math') { void toggleMathMessage(conversationId, messageId, pending.mathId, pending.mathKind, branchId); window.getSelection()?.removeAllRanges(); setPending(null); return }
    if (pending.kind !== 'text') return
    toggleMessageSelection(conversationId, messageId, pending.segments, canonicalOf, branchId)
    window.getSelection()?.removeAllRanges()
    setPending(null)
    } catch { try { window.getSelection()?.removeAllRanges() } catch {}; setPending(null) }
  }
  const mathCovered = pending && pending.kind === 'math' ? hasMath(annotations, pending.mathId) : false
  const fullyCovered = pending && pending.kind === 'text' ? shouldToggleAll(pending.segments.map((s) => ({ anchor: s.cell ? { scope: 'table-cell', tableId: s.cell.tableId, row: s.cell.row, column: s.cell.column } : { scope: 'block', blockId: s.blockId }, start: s.start, end: s.end })), annotations) === 'remove' : mathCovered

  const onTableAction = (tableId: string) => { void toggleWholeTableMessage(conversationId, messageId, tableId, branchId) }
  return (
    <div ref={wrapRef} className={css.wrap} data-highlight={hasHl} data-annotation-owner={highlightOwnerId}>
      <MarkdownBlocks content={content} messageId={messageId} annotations={annotations} onTableAction={onTableAction} onMathAction={onMathAction} parsedRoot={parsedRoot} />
      {pending && pending.kind === 'math' && (
        <div className={css.annotBar}><button className={css.annotBtn} onPointerUp={(e: any) => e.stopPropagation()} onTouchEnd={(e: any) => e.stopPropagation()} onPointerDown={(e: any) => e.stopPropagation()} onClick={doToggle}>{mathCovered ? tx('取消标记', 'Unmark') : tx('标记公式', 'Mark formula')}</button></div>
      )}
      {pending && pending.kind === 'text' && (
        <div className={css.annotBar}><button className={css.annotBtn} onPointerUp={(e: any) => e.stopPropagation()} onTouchEnd={(e: any) => e.stopPropagation()} onPointerDown={(e: any) => e.stopPropagation()} onClick={doToggle}>{fullyCovered ? tx('取消标记', 'Unmark') : tx('标记', 'Mark')}</button></div>
      )}
      {pending && pending.kind === 'table-cross-cell' && (
        <div className={css.annotBar}><button className={css.annotBtn} onPointerUp={(e: any) => e.stopPropagation()} onTouchEnd={(e: any) => e.stopPropagation()} onPointerDown={(e: any) => e.stopPropagation()} onClick={markCrossCell}>{hasExactRectangle(annotations, pending.tableId, normalizeBounds(pending.startCell.row, pending.startCell.column, pending.endCell.row, pending.endCell.column)) ? tx('取消标记', 'Unmark') : tx('标记', 'Mark')}</button></div>
      )}
    </div>
  )
}
