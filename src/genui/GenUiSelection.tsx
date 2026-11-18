import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { registerSelectionOwner } from '../annotations/selection-events'
import { containsNode } from '../annotations/ownership'
import css from '../annotations/annotate.module.css'
import { tx } from '../engine/locale'
import { useSpokenSelection } from '../speech/use-spoken-selection'
import { stopReadAloud } from '../speech/read-aloud'

type SelectedText = { range: Range; text: string; left: number; top: number }

function isControl(node: Node): boolean {
  return !!(node instanceof Element ? node : node.parentElement)?.closest('button, input, textarea, select, [contenteditable], [role="button"], [data-genui-selection-ignore]')
}

export function GenUiSelection({ children, source, className, label }: { children: ReactNode; source: string; className?: string; label?: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const id = 'genui-selection:' + useId()
  const [selected, setSelected] = useState<SelectedText | null>(null)
  const speak = useSpokenSelection(rootRef, id, source)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const dismiss = () => setSelected(null)
    const unregister = registerSelectionOwner(id, {
      dismiss,
      trackTouchSelection: true,
      selectionEnd() {
        const selection = window.getSelection()
        if (!selection?.rangeCount || selection.isCollapsed) { dismiss(); return }
        const range = selection.getRangeAt(0)
        const { startContainer, endContainer } = range
        if (!containsNode(root, startContainer) || !containsNode(root, endContainer) || isControl(startContainer) || isControl(endContainer)) {
          dismiss(); return
        }
        const text = selection.toString().trim()
        const rect = range.getBoundingClientRect()
        if (!text || !rect.width || !rect.height) { dismiss(); return }
        const bounds = root.getBoundingClientRect()
        let visibleTop = 0
        let visibleBottom = window.innerHeight
        for (let parent: HTMLElement | null = root; parent; parent = parent.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
            const viewport = parent.getBoundingClientRect()
            visibleTop = Math.max(visibleTop, viewport.top)
            visibleBottom = Math.min(visibleBottom, viewport.bottom)
          }
        }
        setSelected({
          range: range.cloneRange(), text,
          left: Math.max(0, Math.min(rect.left - bounds.left, bounds.width - 108)),
          top: Math.max(visibleTop, Math.min(visibleBottom - 36, rect.bottom + 56 <= visibleBottom ? rect.bottom + 12 : rect.top - 46)) - bounds.top,
        })
      },
    })
    return () => { unregister(); stopReadAloud(id) }
  }, [id, source])

  useEffect(() => {
    if (!selected) return
    const dismiss = () => setSelected(null)
    const root = rootRef.current
    const initial = root?.getBoundingClientRect()
    const onScroll = (event: Event) => {
      const bounds = root?.getBoundingClientRect()
      if (containsNode(root, event.target as Node | null) || bounds?.top !== initial?.top || bounds?.left !== initial?.left) dismiss()
    }
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', dismiss)
    return () => { document.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', dismiss) }
  }, [selected])

  return <div ref={rootRef} className={[css.wrap, className].filter(Boolean).join(' ')} aria-label={label} data-genui-selection data-annotatable="false" data-annotation-owner={id}>
    {children}
    {selected && <div className={css.annotBar} style={{ left: selected.left, top: selected.top, visibility: 'visible' }}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation() }} onPointerUp={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}>
      <button type="button" className={css.annotBtn} data-testid="selection-read-aloud" onClick={() => { speak(selected.text, selected.range); setSelected(null) }}>{tx('朗读', 'Read aloud')}</button>
    </div>}
  </div>
}
