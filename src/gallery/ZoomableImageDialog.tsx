// Unified zoomable image viewer (product-level, portal to body). One interaction
// surface for: sent-message images (Gallery), composer draft images, and PDF
// context pages. Owns short-lived transform state only (scale/tx/ty) — nothing
// about zoom is stored in the gallery-store.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clampScale, clampPan, zoomAtPoint, resetTransform, DOUBLE_CLICK_SCALE } from './zoom'
import css from './zoomable-image.module.css'

export interface ZoomableImageDialogProps {
  src?: string
  alt?: string
  /** Reset transform whenever this changes (e.g. switching to another image). */
  resetKey?: string | number
  index?: number
  count?: number
  onPrev?: () => void
  onNext?: () => void
  onBackToList?: () => void
  onClose: () => void
  labels: { close: string; prev?: string; next?: string; backToList?: string; dialog: string }
}

type Nd = { x: number; y: number }

export function ZoomableImageDialog(props: ZoomableImageDialogProps) {
  const { src, alt = '', resetKey, index, count, onPrev, onNext, onBackToList, onClose, labels } = props
  const stageRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const scaleRef = useRef(scale); scaleRef.current = scale
  const txRef = useRef(tx); txRef.current = tx
  const tyRef = useRef(ty); tyRef.current = ty
  const pointers = useRef(new Map<number, Nd>())
  const pinchRef = useRef<{ d0: number; s0: number; tx0: number; ty0: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number; moved: number } | null>(null)
  const lastMovedRef = useRef(0)

  const base = useCallback(() => {
    if (!nat || stage.w <= 0 || stage.h <= 0) return null
    const fit = Math.min(stage.w / nat.w, stage.h / nat.h)
    return { w: nat.w * fit, h: nat.h * fit }
  }, [nat, stage])

  const setT = useCallback((s: number, x: number, y: number) => {
    const b = base()
    if (b) { const c = clampPan(x, y, s, stage.w, stage.h, b.w, b.h); setTx(c.tx); setTy(c.ty) } else { setTx(x); setTy(y) }
    setScale(clampScale(s))
  }, [base, stage])

  const bump = useCallback((factor: number) => {
    const s = scaleRef.current
    const ns = clampScale(s * factor)
    if (ns === s) return
    const el = stageRef.current
    const cx = el ? el.clientWidth / 2 : 0
    const cy = el ? el.clientHeight / 2 : 0
    const z = zoomAtPoint(s, ns, cx, cy, cx, cy, txRef.current, tyRef.current)
    setT(ns, z.tx, z.ty)
  }, [setT])

  // Reset transform on image change.
  useEffect(() => { const t = resetTransform(); setScale(t.scale); setTx(t.tx); setTy(t.ty) }, [src, resetKey])

  // Focus restore + keyboard while open.
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); bump(1.25) }
      else if (e.key === '-') { e.preventDefault(); bump(1 / 1.25) }
      else if (e.key === '0') { e.preventDefault(); setT(1, 0, 0) }
      else if (e.key === 'ArrowLeft') { if (onPrev) onPrev() }
      else if (e.key === 'ArrowRight') { if (onNext) onNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); restoreRef.current?.focus() }
  }, [onClose, onPrev, onNext, bump, setT])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { setStage({ w: el.clientWidth, h: el.clientHeight }) })
    ro.observe(el); setStage({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // wheel: non-passive, pointer-centered, smooth
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = scaleRef.current
      const ns = clampScale(s * Math.pow(1.0015, -e.deltaY))
      if (ns === s) return
      const rect = el.getBoundingClientRect()
      const z = zoomAtPoint(s, ns, e.clientX - rect.left, e.clientY - rect.top, rect.width / 2, rect.height / 2, txRef.current, tyRef.current)
      setT(ns, z.tx, z.ty)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setT])

  const onPointerDown = (e: React.PointerEvent) => {
    lastMovedRef.current = 0
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchRef.current = { d0: Math.hypot(a.x - b.x, a.y - b.y), s0: scaleRef.current, tx0: txRef.current, ty0: tyRef.current }
      dragRef.current = null
    } else if (pointers.current.size === 1) {
      dragRef.current = { x: e.clientX, y: e.clientY, moved: 0 }
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    const prev = pointers.current.get(e.pointerId)!
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const p = pinchRef.current
      const ns = clampScale(p.s0 * (d / p.d0))
      const rect = stageRef.current?.getBoundingClientRect()
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      const cx = rect ? rect.width / 2 : 0, cy = rect ? rect.height / 2 : 0
      const z = zoomAtPoint(p.s0, ns, mx - (rect?.left || 0), my - (rect?.top || 0), cx, cy, p.tx0, p.ty0)
      setT(ns, z.tx, z.ty)
      lastMovedRef.current = 10
      return
    }
    if (pointers.current.size === 1 && dragRef.current) {
      const d = dragRef.current
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      d.moved += Math.abs(dx) + Math.abs(dy)
      d.x = e.clientX; d.y = e.clientY
      lastMovedRef.current = d.moved
      if (scaleRef.current > 1) {
        const b = base()
        if (b) { const c = clampPan(txRef.current + dx, tyRef.current + dy, scaleRef.current, stage.w, stage.h, b.w, b.h); setTx(c.tx); setTy(c.ty) }
        else { setTx(txRef.current + dx); setTy(tyRef.current + dy) }
      }
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchRef.current = null
    if (pointers.current.size === 0) dragRef.current = null
  }
  const onDoubleClick = (e: React.MouseEvent) => {
    const rect = stageRef.current!.getBoundingClientRect()
    const s = scaleRef.current
    const target = s < DOUBLE_CLICK_SCALE ? DOUBLE_CLICK_SCALE : 1
    const z = zoomAtPoint(s, target, e.clientX - rect.left, e.clientY - rect.top, rect.width / 2, rect.height / 2, txRef.current, tyRef.current)
    setT(target, z.tx, z.ty)
  }
  // Click on empty stage area closes; a pan suppresses it; clicks on the image don't close.
  const onStageClick = (e: React.MouseEvent) => {
    if (lastMovedRef.current > 4) return
    if ((e.target as HTMLElement) !== stageRef.current) return
    onClose()
  }

  // scale=1 must mean fit-to-viewport: render the img at the base (fit) size so the
  // transform math (image centered on the stage) matches what the user sees.
  const fit = base()
  const percent = Math.round(scale * 100)
  const hasNav = count !== undefined && count > 1

  return createPortal(
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-label={labels.dialog}>
      <div
        ref={stageRef}
        className={css.stage}
        data-testid="viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onClick={onStageClick}
      >
        {src ? <img className={css.image} data-testid="viewer-image" src={src} alt={alt} draggable={false}
          style={{ width: fit ? fit.w : undefined, height: fit ? fit.h : undefined, transform: 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + scale + ')', willChange: 'transform' }}
          onLoad={e => { const el = e.currentTarget; setNat({ w: el.naturalWidth, h: el.naturalHeight }) }}
        /> : <div className={css.missing}>无法读取这张图片</div>}
      </div>
      <div className={css.topbar}>
        <div className={css.toolbar} onPointerDown={e => e.stopPropagation()}>
          <button type="button" className={css.zbtn} aria-label="缩小" data-testid="viewer-zoom-out" onClick={() => bump(1 / 1.25)}>−</button>
          <span className={css.percent} data-testid="viewer-percent">{percent}%</span>
          <button type="button" className={css.zbtn} aria-label="放大" data-testid="viewer-zoom-in" onClick={() => bump(1.25)}>+</button>
          <button type="button" className={css.zfit} data-testid="viewer-fit" onClick={() => setT(1, 0, 0)}>适应屏幕</button>
        </div>
        <div className={css.toolbar} onPointerDown={e => e.stopPropagation()}>
          {hasNav && onPrev && <button type="button" className={css.ctrl} data-testid="viewer-prev" disabled={index! <= 0} onClick={onPrev}>{labels.prev || '上一张'}</button>}
          {hasNav && <span className={css.counter}>{index! + 1} / {count}</span>}
          {hasNav && onNext && <button type="button" className={css.ctrl} data-testid="viewer-next" disabled={index! >= count! - 1} onClick={onNext}>{labels.next || '下一张'}</button>}
          {onBackToList && <button type="button" className={css.ctrl} onClick={onBackToList}>{labels.backToList || '返回列表'}</button>}
        </div>
      </div>
      <button ref={restoreRef as any} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>✕</button>
    </div>,
    document.body,
  )
}
