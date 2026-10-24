import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import type { Annotation } from './annotation-types'
import css from './annotate.module.css'
import { tx } from '../engine/locale'
import { readAloud, stopReadAloud } from '../speech/read-aloud'
import { selectMarkdownBlock } from '../markdown/select-block'
import { markdownSourceForRange } from '../markdown/source-copy'

type AnnotationEventOwner = {
  element: HTMLElement
  pointerDown(event: Event): void
  selectionEnd(): void
}

const eventOwners = new Map<string, AnnotationEventOwner>()
let activeEventOwner: string | null = null
let annotationEventsInstalled = false
let draggingSelection = false

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
  draggingSelection = true
  const previous = activeEventOwner ? eventOwners.get(activeEventOwner) : undefined
  if (previous && !containsNode(previous.element, event.target as Node | null)) previous.pointerDown(event)
  const found = eventOwnerForNode(event.target as Node | null)
  activeEventOwner = found?.[0] ?? null
  found?.[1].pointerDown(event)
}
const delegatedSelectionEnd = (event?: Event) => {
  if (event?.type === 'pointerup' || event?.type === 'pointercancel' || event?.type === 'touchend' || event?.type === 'blur') draggingSelection = false
  if (draggingSelection) return
  const found = eventOwnerForSelection()
  if (found) { activeEventOwner = found[0]; found[1].selectionEnd(); return }
  if (activeEventOwner) eventOwners.get(activeEventOwner)?.selectionEnd()
}

function installAnnotationEvents(): void {
  if (annotationEventsInstalled || typeof document === 'undefined') return
  annotationEventsInstalled = true
  document.addEventListener('selectionchange', delegatedSelectionEnd)
  document.addEventListener('pointerdown', delegatedPointerDown)
  document.addEventListener('pointerup', delegatedSelectionEnd)
  document.addEventListener('pointercancel', delegatedSelectionEnd)
  window.addEventListener('blur', delegatedSelectionEnd)
  document.addEventListener('touchend', delegatedSelectionEnd)
}

function uninstallAnnotationEventsIfIdle(): void {
  if (!annotationEventsInstalled || eventOwners.size > 0 || typeof document === 'undefined') return
  annotationEventsInstalled = false
  activeEventOwner = null
  draggingSelection = false
  document.removeEventListener('selectionchange', delegatedSelectionEnd)
  document.removeEventListener('pointerdown', delegatedPointerDown)
  document.removeEventListener('pointerup', delegatedSelectionEnd)
  document.removeEventListener('pointercancel', delegatedSelectionEnd)
  window.removeEventListener('blur', delegatedSelectionEnd)
  document.removeEventListener('touchend', delegatedSelectionEnd)
}

export function AnnotatedMarkdown({ content, messageId, conversationId, branchId, focusAnnotation }: { content: string; messageId: string; conversationId: string; branchId?: string; focusAnnotation?: Annotation }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const lastTap = useRef<{time: number; x: number; y: number; target: EventTarget | null} | null>(null)
  const touchStart = useRef<{x: number; y: number} | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const highlightOwnerId = messageId + ':' + useId()
  const [pending, setPending] = useState<SelectionMapping | null>(null)
  const [toolbarPosition, setToolbarPosition] = useState<{ left: number; top: number } | null>(null)
  const annotations = useMessageAnnotations(conversationId, messageId)
  const parsedRoot = useMemo(() => parseMarkdown(content), [content])
  const { blocks, canonicalOf } = useMemo(() => buildBlockMapFromRoot(parsedRoot, messageId), [parsedRoot, messageId])
  const hasHl = highlightSupported()
  useLayoutEffect(()=>{
    if(!focusAnnotation) return
    const frame=requestAnimationFrame(()=>{
      const root=wrapRef.current?.querySelector<HTMLElement>('[data-message-id]')
      if(!root) return
      const target=focusAnnotation.target
      let bounds: DOMRect | undefined
      if(target.type==='text') {
        const candidate=resolveToRange(root,messageId,target)
        const range=candidate?.toString()===target.quote.exact ? candidate : resolveByExact(root,messageId,target.quote.exact)
        bounds=range?.getBoundingClientRect()
      }
      else {
        const selector=target.type==='math' ? '[data-math-id="'+CSS.escape(target.mathId)+'"]' : '[data-table-id="'+CSS.escape(target.tableId)+'"]'
        bounds=root.querySelector(selector)?.getBoundingClientRect()
      }
      if(!bounds) return
      for(let parent=root.parentElement;parent;parent=parent.parentElement) {
        if(/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
          const viewport=parent.getBoundingClientRect()
          parent.scrollTop+=(bounds.top+bounds.bottom-viewport.top-viewport.bottom)/2
          break
        }
      }
    })
    return()=>cancelAnimationFrame(frame)
  },[focusAnnotation,messageId,content])
  useLayoutEffect(() => {
    const root = wrapRef.current
    if (!pending || !root) { setToolbarPosition(null); return }
    const selection = window.getSelection()
    const anchor = pending.kind === 'math'
      ? (()=>{
        const math=Array.from(root.querySelectorAll<HTMLElement>('[data-math-id]')).find(el=>el.dataset.mathId===pending.mathId)
        if(!math)return null
        const bounds=math.getBoundingClientRect(), visual=(math.querySelector('.katex-html')??math).getBoundingClientRect()
        // Align horizontally to the glyphs, while leaving the formula's full
        // line box clear vertically (KaTeX baseline metrics can differ).
        return {left:visual.left,width:visual.width,top:bounds.top,bottom:bounds.bottom,height:bounds.height}
      })()
      : selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
    if (!anchor || !anchor.width || !anchor.height) { setToolbarPosition(null); return }
    const bounds = root.getBoundingClientRect()
    let visibleBottom = window.innerHeight
    for (let parent = root.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
        visibleBottom = Math.min(visibleBottom, parent.getBoundingClientRect().bottom)
      }
    }
    setToolbarPosition({
      left: Math.max(0, Math.min(anchor.left - bounds.left, bounds.width - 216)),
      top: (anchor.bottom + 48 <= visibleBottom ? anchor.bottom + 6 : anchor.top - 42) - bounds.top,
    })
  }, [pending])

  useEffect(() => {
    if (!pending) return
    const root = wrapRef.current
    const initialBounds = root?.getBoundingClientRect()
    const dismiss = () => setPending(null)
    const onScroll = (event: Event) => {
      const bounds = root?.getBoundingClientRect()
      // Ignore queued scroll events from bringing the selection into view before
      // the toolbar opened. Only a subsequent movement should dismiss it.
      if (containsNode(root, event.target as Node | null) || bounds?.top !== initialBounds?.top || bounds?.left !== initialBounds?.left) dismiss()
    }
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [pending])
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
    function onPointerDown(e: Event) {
      setPending(null)
      // Ownership guard: only the instance whose wrapper contains the target may
      // register a math press. A formula in ANOTHER message must never put this
      // instance into pending-math.
    }
    function onSelChange() {
      const sel = window.getSelection()
      // Math click: pointerup landed on a formula inside THIS message (guarded by
      // ownedMath in onPointerDown). Only the owning instance may enter pending-math.
      // A formula click can produce a delayed collapsed selectionchange after
      // click. Keep its action open until an explicit dismissal or annotation.
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setPending(null)
        return
      }
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
    const element = wrapRef.current
    if (!element) return
    eventOwners.set(highlightOwnerId, { element, pointerDown: onPointerDown, selectionEnd: onSelChange })
    installAnnotationEvents()
    return () => {
      stopReadAloud(highlightOwnerId)
      eventOwners.delete(highlightOwnerId)
      if (activeEventOwner === highlightOwnerId) activeEventOwner = null
      uninstallAnnotationEventsIfIdle()
    }
  }, [messageId, content, canonicalOf, highlightOwnerId])

  const markCrossCell = () => { if (!pending || pending.kind !== 'table-cross-cell') return; const a = pending.startCell, b = pending.endCell; const bounds = normalizeBounds(a.row, a.column, b.row, b.column); void toggleTableCellsMessage(conversationId, messageId, pending.tableId, bounds, branchId); window.getSelection()?.removeAllRanges(); setPending(null) }
  const onMathAction = useCallback((mathId: string, kind: 'inline' | 'block') => {
    // A click is not a selection. Only a real, non-collapsed native range
    // may expose annotation controls; scrolling/hovering must never select math.
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    const start = ownedMath(wrapRef.current, range.startContainer)
    const end = ownedMath(wrapRef.current, range.endContainer)
    if (start?.id === mathId && end?.id === mathId) setPending({ kind: 'math', mathId, mathKind: kind })
  }, [])
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

  const onTableAction = useCallback((tableId: string) => { void toggleWholeTableMessage(conversationId, messageId, tableId, branchId) }, [conversationId, messageId, branchId])
  const copySelection = async () => {
    const selection = window.getSelection(), root = wrapRef.current?.querySelector<HTMLElement>('[data-markdown-source-root]')
    if (!root || !selection?.rangeCount || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    const text = markdownSourceForRange(root, content, range) ?? selection.toString()
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
      else if (!document.execCommand('copy')) throw new Error('copy_failed')
      setCopyStatus(tx('已复制', 'Copied'))
    } catch {
      // Some Android WebViews expose Clipboard but reject writeText. Preserve
      // the native range and let the existing source-aware copy handler run.
      try { if (!document.execCommand('copy')) throw new Error();setCopyStatus(tx('已复制','Copied')) }
      catch {setCopyStatus(tx('请用系统复制', 'Use system copy'))}
    }
  }
  // Updating the selection toolbar must not rebuild KaTeX's nested DOM while
  // the browser owns a native Range anchored in those nodes.
  const markdown = useMemo(() => <MarkdownBlocks content={content} messageId={messageId} annotations={annotations} onTableAction={onTableAction} onMathAction={onMathAction} parsedRoot={parsedRoot} />, [content, messageId, annotations, onTableAction, onMathAction, parsedRoot])
  return (
    <div ref={wrapRef} className={css.wrap} onDoubleClick={event => {
      if (selectMarkdownBlock(event.currentTarget, event.target)) { event.preventDefault(); event.stopPropagation(); setCopyStatus('') }
    }} onPointerDownCapture={event => {
      if (event.pointerType === 'touch') touchStart.current = {x:event.clientX,y:event.clientY}
      setCopyStatus('')
    }} onPointerUp={event => {
      if (event.pointerType !== 'touch') return
      const start = touchStart.current; touchStart.current = null
      if (!start || Math.hypot(event.clientX-start.x,event.clientY-start.y)>12) { lastTap.current=null; return }
      const tap=lastTap.current, time=performance.now()
      if (tap && time-tap.time<350 && tap.target===event.target && Math.hypot(event.clientX-tap.x,event.clientY-tap.y)<24) {
        if (selectMarkdownBlock(event.currentTarget,event.target)) { event.preventDefault(); lastTap.current=null }
      } else lastTap.current={time,x:event.clientX,y:event.clientY,target:event.target}
    }} style={{ '--annotation-left': `${toolbarPosition?.left ?? 0}px`, '--annotation-top': `${toolbarPosition?.top ?? 0}px`, '--annotation-visibility': toolbarPosition ? 'visible' : 'hidden' } as React.CSSProperties} data-highlight={hasHl} data-annotation-owner={highlightOwnerId}>
      {markdown}
      {pending && pending.kind === 'math' && (
        <div className={css.annotBar} onPointerDown={e => { e.preventDefault(); e.stopPropagation() }} onPointerUp={e => e.stopPropagation()} onTouchEnd={e => e.stopPropagation()}>
          <button type="button" className={css.annotBtn} onClick={doToggle}>{mathCovered ? tx('取消标记', 'Unmark') : tx('标记公式', 'Mark formula')}</button>
          <button type="button" className={css.annotBtn} data-testid="selection-copy" onClick={()=>void copySelection()}>{copyStatus || tx('复制', 'Copy')}</button>
        </div>
      )}
      {pending && pending.kind === 'text' && (
        <div className={css.annotBar} onPointerDown={event=>{event.preventDefault();event.stopPropagation()}} onPointerUp={event=>event.stopPropagation()} onTouchEnd={event=>event.stopPropagation()}>
          <button type="button" className={css.annotBtn} data-testid="selection-copy" onClick={()=>void copySelection()}>{copyStatus || tx('复制', 'Copy')}</button>
          <button className={css.annotBtn} onPointerUp={(e: any) => e.stopPropagation()} onTouchEnd={(e: any) => e.stopPropagation()} onPointerDown={(e: any) => e.stopPropagation()} onClick={doToggle}>{fullyCovered ? tx('取消标记', 'Unmark') : tx('标记', 'Mark')}</button>
          <button type="button" className={css.annotBtn} data-testid="selection-read-aloud" title={tx('自动识别语言；倍速及重复次数可在通用设置调整，优先使用 Edge 在线声音','Detects language automatically. Adjust speed and repetitions in General settings; prefers Edge online voices.')} onPointerDown={e=>{e.preventDefault();e.stopPropagation()}} onPointerUp={e=>e.stopPropagation()} onTouchEnd={e=>e.stopPropagation()} onClick={()=>{readAloud(pending.segments.map(segment=>segment.exact).join('\n').replaceAll('\uFFFF',' '),highlightOwnerId);setPending(null)}}>{tx('朗读','Read aloud')}</button>
        </div>
      )}
      {pending && pending.kind === 'table-cross-cell' && (
        <div className={css.annotBar} onPointerDown={event=>{event.preventDefault();event.stopPropagation()}} onPointerUp={event=>event.stopPropagation()} onTouchEnd={event=>event.stopPropagation()}><button className={css.annotBtn} onClick={markCrossCell}>{hasExactRectangle(annotations, pending.tableId, normalizeBounds(pending.startCell.row, pending.startCell.column, pending.endCell.row, pending.endCell.column)) ? tx('取消标记', 'Unmark') : tx('标记', 'Mark')}</button><button type="button" className={css.annotBtn} data-testid="selection-copy" onClick={()=>void copySelection()}>{copyStatus || tx('复制','Copy')}</button></div>
      )}
    </div>
  )
}
