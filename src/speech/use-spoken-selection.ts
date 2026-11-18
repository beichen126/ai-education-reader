import { useEffect, useRef, useState, type RefObject } from 'react'
import { containsNode } from '../annotations/ownership'
import { highlightSupported, setSpokenSelectionRanges } from '../annotations/highlight-registry'
import { getSettingsSnapshot, useSettings } from '../engine/settings-store'
import { readAloud } from './read-aloud'

type SpokenSelection = { range: Range; selectedText: string; speechText: string; revision: string }
type Tap = { x: number; y: number; time: number }

function ownsRange(root: HTMLElement | null, range: Range): boolean {
  return containsNode(root, range.startContainer) && containsNode(root, range.endContainer)
}

function near(a: Tap, b: Tap, distance: number, delay: number): boolean {
  return b.time - a.time < delay && Math.hypot(a.x - b.x, a.y - b.y) < distance
}

const controls = 'button, input, textarea, select, [contenteditable], [role="button"]'

function paintRanges(root: HTMLElement, owner: string, ranges: Range[]): () => void {
  if (highlightSupported()) {
    setSpokenSelectionRanges(owner, ranges)
    return () => setSpokenSelectionRanges(owner, [])
  }
  // Older WebViews still support Range geometry. Paint an underline without
  // wrapping the text nodes that the native selection and GenUI own.
  const layer = document.createElement('span')
  layer.className = 'spoken-selection-underlines'
  layer.setAttribute('aria-hidden', 'true')
  root.append(layer)
  const update = () => {
    const bounds = layer.getBoundingClientRect()
    layer.replaceChildren(...ranges.flatMap(range => Array.from(range.getClientRects(), rect => {
      const mark = document.createElement('span')
      mark.style.cssText = `left:${rect.left - bounds.left}px;top:${rect.bottom - bounds.top}px;width:${rect.width}px`
      return mark
    })))
  }
  update()
  window.addEventListener('resize', update)
  root.addEventListener('scroll', update, true)
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
  observer?.observe(root)
  return () => {
    observer?.disconnect()
    window.removeEventListener('resize', update)
    root.removeEventListener('scroll', update, true)
    layer.remove()
  }
}

export function useSpokenSelection(rootRef: RefObject<HTMLElement>, owner: string, revision: string) {
  const enabled = useSettings(s => s.highlightSpokenSelection === true)
  const [entries, setEntries] = useState<SpokenSelection[]>([])
  const lastTouchReplay = useRef<Tap | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled || !entries.length) return
    const valid = (entry: SpokenSelection) => entry.revision === revision && ownsRange(root, entry.range) && !entry.range.collapsed && entry.range.toString() === entry.selectedText
    const current = entries.filter(valid)
    if (current.length !== entries.length) setEntries(current)
    if (!current.length) return
    const removePaint = paintRanges(root, owner, current.map(entry => entry.range))
    const observer = new MutationObserver(() => {
      if (current.some(entry => !valid(entry))) setEntries(previous => previous.filter(valid))
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true })

    let start: Tap | null = null
    let firstTap: Tap | null = null
    const point = (event: MouseEvent): Tap => ({ x: event.clientX, y: event.clientY, time: event.timeStamp })
    const replay = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(controls) || event.target.closest('[data-annotation-owner]') !== root) return false
      const target = [...current].reverse().find(entry => valid(entry) &&
        Array.from(entry.range.getClientRects()).some(rect => rect.width > 0 && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom))
      if (!target) return false
      readAloud(target.speechText, owner)
      return true
    }
    const consume = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      window.getSelection()?.removeAllRanges()
    }
    const onDoubleClick = (event: MouseEvent) => {
      if ((lastTouchReplay.current && near(lastTouchReplay.current, point(event), 24, 450)) || replay(event)) consume(event)
    }
    const onPointerDown = (event: PointerEvent) => { start = event.pointerType === 'touch' && event.isPrimary ? point(event) : null }
    const onPointerCancel = () => { start = firstTap = null }
    const onPointerUp = (event: PointerEvent) => {
      const tap = point(event)
      if (!start || !near(start, tap, 14, 300)) { onPointerCancel(); return }
      start = null
      if (firstTap && near(firstTap, tap, 24, 350) && replay(event)) {
        firstTap = null
        lastTouchReplay.current = tap
        consume(event)
      } else firstTap = tap
    }
    root.addEventListener('dblclick', onDoubleClick, true)
    root.addEventListener('pointerdown', onPointerDown, true)
    root.addEventListener('pointerup', onPointerUp, true)
    root.addEventListener('pointercancel', onPointerCancel, true)
    return () => {
      observer.disconnect()
      root.removeEventListener('dblclick', onDoubleClick, true)
      root.removeEventListener('pointerdown', onPointerDown, true)
      root.removeEventListener('pointerup', onPointerUp, true)
      root.removeEventListener('pointercancel', onPointerCancel, true)
      removePaint()
    }
  }, [enabled, entries, owner, revision, rootRef])

  return (speechText: string, explicitRange?: Range) => {
    const selection = window.getSelection()
    const range = explicitRange ?? (selection?.rangeCount ? selection.getRangeAt(0) : undefined)
    const captured = enabled && range && !range.collapsed && ownsRange(rootRef.current, range) ? range.cloneRange() : undefined
    const selectedText = captured?.toString()
    readAloud(speechText, owner, { onStarted: () => {
      if (!getSettingsSnapshot().highlightSpokenSelection || !captured || !selectedText || !ownsRange(rootRef.current, captured) || captured.toString() !== selectedText) return
      setEntries(previous => [...previous.filter(entry => entry.revision === revision &&
        (entry.range.compareBoundaryPoints(Range.START_TO_START, captured) !== 0 || entry.range.compareBoundaryPoints(Range.END_TO_END, captured) !== 0)), { range: captured, selectedText, speechText, revision }])
    } })
    selection?.removeAllRanges()
  }
}
