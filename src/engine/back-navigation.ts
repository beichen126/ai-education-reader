import { useEffect, useRef } from 'react'

const targets: { close: () => void; priority: number }[] = []
const marker = '__readerOverlay'
let installed = false
let lastPop = 0
export function readerBack(): boolean {
  const target = targets.at(-1)
  if (!target) return false
  target.close()
  return true
}
function install() {
  if (installed) return
  installed = true
  ;(window as unknown as { __readerBack: typeof readerBack }).__readerBack = readerBack
  window.addEventListener('popstate', () => {
    lastPop = performance.now()
    if (readerBack()) queueMicrotask(() => {
      if (targets.length && !history.state?.[marker]) history.pushState({ ...history.state, [marker]: true }, '')
    })
  })
  let start: { x: number; y: number; side: number } | undefined
  document.addEventListener('touchstart', event => {
    start = undefined
    if (!targets.length || event.touches.length !== 1) return
    if (window.getSelection()?.toString()) return
    if (event.target instanceof Element && event.target.closest('input,textarea,select,canvas,[contenteditable="true"]')) return
    for (let node = event.target instanceof Element ? event.target : null; node; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return
    }
    const { clientX: x, clientY: y } = event.touches[0]
    if (x <= 24 || x >= innerWidth - 24) start = { x, y, side: x <= 24 ? 1 : -1 }
  }, { passive: true })
  document.addEventListener('touchcancel', () => { start = undefined }, { passive: true })
  document.addEventListener('touchend', event => {
    const from = start; start = undefined
    if (!from || event.changedTouches.length !== 1 || performance.now() - lastPop < 350) return
    const point = event.changedTouches[0]
    if ((point.clientX - from.x) * from.side > 72 && Math.abs(point.clientY - from.y) < 40) readerBack()
  }, { passive: true })
}

/** One back owner: native/system/browser/edge swipe all close only the top surface. */
export function useBackTarget(active: boolean, close: () => void, priority = 50) {
  const callback = useRef(close); callback.current = close
  useEffect(() => {
    if (!active) return
    install()
    const target = { close: () => callback.current(), priority }
    targets.push(target)
    targets.sort((a, b) => a.priority - b.priority)
    if (!history.state?.[marker]) history.pushState({ ...history.state, [marker]: true }, '')
    return () => {
      const index = targets.indexOf(target)
      if (index >= 0) targets.splice(index, 1)
      queueMicrotask(() => { if (!targets.length && history.state?.[marker]) history.back() })
    }
  }, [active, priority])
}
