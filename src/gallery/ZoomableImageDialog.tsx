// Unified zoomable image viewer (product-level, portal to body). One interaction
// surface for: sent-message images (Gallery), composer draft images, and PDF
// context pages. Owns short-lived transform state only (scale/tx/ty) — nothing
// about zoom is stored in the gallery-store.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clampScale, clampPan, zoomAtPoint, resetTransform, DOUBLE_CLICK_SCALE } from './zoom'
import css from './zoomable-image.module.css'
import { tx as localeText } from '../engine/locale'
import { MediaRotateButton } from '../dsh/MediaRotateButton'
import { MediaInvertButton, useMediaInversion } from '../dsh/MediaInversion'
import { useBackTarget } from '../engine/back-navigation'

export interface ZoomableImageDialogProps {
  src?: string
  alt?: string
  /** Reset transform whenever this changes (e.g. switching to another image). */
  resetKey?: string | number
  rotation?: number
  onRotate?: () => void
  index?: number
  count?: number
  onPrev?: () => void
  onNext?: () => void
  onBackToList?: () => void
  onClose: () => void
  headerAction?: ReactNode
  labels: { close: string; prev?: string; next?: string; backToList?: string; dialog: string }
}

type Nd = { x: number; y: number }

export function ZoomableImageDialog(props: ZoomableImageDialogProps) {
  const { inverted, mediaClass } = useMediaInversion()
  const { src, alt = '', resetKey, index, count, onPrev, onNext, onBackToList, onClose, headerAction, labels } = props
  useBackTarget(true, onBackToList || onClose)
  const stageRef = useRef<HTMLDivElement | null>(null)
  // Two separate refs: openerRef remembers the element that opened the viewer
  // (thumbnail / draft image / PDF page); closeRef targets the close button.
  // Sharing one ref would let the JSX ref overwrite the captured opener.
  const openerRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [imageRotation, setImageRotation] = useState({ key: resetKey, angle: 0 })
  const rotation = props.rotation ?? (imageRotation.key === resetKey ? imageRotation.angle : 0)
  const sideways = rotation % 180 !== 0
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const scaleRef = useRef(scale); scaleRef.current = scale
  const txRef = useRef(tx); txRef.current = tx
  const tyRef = useRef(ty); tyRef.current = ty
  const pointers = useRef(new Map<number, Nd>())
  const pinchRef = useRef<{ mx0: number; my0: number; d0: number; s0: number; tx0: number; ty0: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number; moved: number } | null>(null)
  const lastMovedRef = useRef(0)
  // Transient zoom HUD: shows the current percent only while the user actually
  // zooms (wheel / pinch / dblclick / keyboard), auto-hidden ~3s after the last
  // effective zoom input. No persistent toolbar, no layout footprint.
  const [zoomHudVisible, setZoomHudVisible] = useState(false)
  const zoomHudTimerRef = useRef<number | null>(null)
  const showZoomHud = useCallback(() => {
    setZoomHudVisible(true)
    if (zoomHudTimerRef.current !== null) { window.clearTimeout(zoomHudTimerRef.current) }
    zoomHudTimerRef.current = window.setTimeout(() => { setZoomHudVisible(false); zoomHudTimerRef.current = null }, 3000)
  }, [])

  const base = useCallback(() => {
    if (!nat || stage.w <= 0 || stage.h <= 0) return null
    const w = sideways ? nat.h : nat.w
    const h = sideways ? nat.w : nat.h
    const fit = Math.min(stage.w / w, stage.h / h)
    return { w: w * fit, h: h * fit }
  }, [nat, stage, sideways])

  const setT = useCallback((s: number, x: number, y: number) => {
    const b = base()
    const next = b ? clampPan(x, y, s, stage.w, stage.h, b.w, b.h) : { tx:x, ty:y }
    txRef.current = next.tx
    tyRef.current = next.ty
    scaleRef.current = clampScale(s)
    setTx(next.tx); setTy(next.ty); setScale(scaleRef.current)
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

  // Reset transform on image change — and drop any zoom HUD state so image 2
  // never inherits image 1's visible percent or pending hide timer.
  useEffect(() => {
    pointers.current.clear(); pinchRef.current = null; dragRef.current = null
    const t = resetTransform(); setScale(t.scale); setTx(t.tx); setTy(t.ty)
    setZoomHudVisible(false)
    if (zoomHudTimerRef.current !== null) { window.clearTimeout(zoomHudTimerRef.current); zoomHudTimerRef.current = null }
  }, [src, resetKey, rotation])

  // Unmount cleanup: never let the hide timer fire state updates after close.
  useEffect(() => () => {
    if (zoomHudTimerRef.current !== null) { window.clearTimeout(zoomHudTimerRef.current); zoomHudTimerRef.current = null }
  }, [])

  // On mount (layout phase, before paint): capture the opener once, then move
  // initial focus into the dialog (the close button) so the background opener
  // never keeps focus while the modal is open.
  useLayoutEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
  }, [])

  // Keyboard while open; on close, restore focus to the captured opener.
  // All callbacks go through refs so this effect registers exactly once — a
  // deps-driven re-run would ALSO run its cleanup (and steal focus back to the
  // opener while the dialog is still open).
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose
  const onPrevRef = useRef(onPrev); onPrevRef.current = onPrev
  const onNextRef = useRef(onNext); onNextRef.current = onNext
  const bumpRef = useRef(bump); bumpRef.current = bump
  const setTRef = useRef(setT); setTRef.current = setT
  const showZoomHudRef = useRef(showZoomHud); showZoomHudRef.current = showZoomHud
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); bumpRef.current(1.25); showZoomHudRef.current() }
      else if (e.key === '-') { e.preventDefault(); bumpRef.current(1 / 1.25); showZoomHudRef.current() }
      else if (e.key === '0') { e.preventDefault(); setTRef.current(1, 0, 0); showZoomHudRef.current() }
      else if (e.key === 'ArrowLeft') { if (onPrevRef.current) onPrevRef.current() }
      else if (e.key === 'ArrowRight') { if (onNextRef.current) onNextRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); openerRef.current?.focus() }
  }, [])

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
      if (ns === s) return // clamped at min/max: no effective zoom -> no HUD pulse
      const rect = el.getBoundingClientRect()
      const z = zoomAtPoint(s, ns, e.clientX - rect.left, e.clientY - rect.top, rect.width / 2, rect.height / 2, txRef.current, tyRef.current)
      setT(ns, z.tx, z.ty)
      showZoomHud()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setT, showZoomHud])

  const onPointerDown = (e: React.PointerEvent) => {
    lastMovedRef.current = 0
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchRef.current = { mx0: (a.x+b.x)/2, my0: (a.y+b.y)/2, d0: Math.max(1,Math.hypot(a.x - b.x, a.y - b.y)), s0: scaleRef.current, tx0: txRef.current, ty0: tyRef.current }
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
      const z = zoomAtPoint(p.s0, ns, p.mx0 - (rect?.left || 0), p.my0 - (rect?.top || 0), cx, cy, p.tx0, p.ty0)
      setT(ns, z.tx + mx - p.mx0, z.ty + my - p.my0)
      showZoomHud() // live percent while pinching; timer keeps resetting
      lastMovedRef.current = 10
      return
    }
    if (pointers.current.size === 1 && dragRef.current) {
      const d = dragRef.current
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      d.moved += Math.abs(dx) + Math.abs(dy)
      d.x = e.clientX; d.y = e.clientY
      lastMovedRef.current = d.moved
      setT(scaleRef.current, txRef.current + dx, tyRef.current + dy)
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchRef.current = null
    const remaining = pointers.current.values().next().value
    dragRef.current = remaining ? { ...remaining, moved: lastMovedRef.current } : null
  }
  const onDoubleClick = (e: React.MouseEvent) => {
    const rect = stageRef.current!.getBoundingClientRect()
    const s = scaleRef.current
    const target = s < DOUBLE_CLICK_SCALE ? DOUBLE_CLICK_SCALE : 1
    const z = zoomAtPoint(s, target, e.clientX - rect.left, e.clientY - rect.top, rect.width / 2, rect.height / 2, txRef.current, tyRef.current)
    setT(target, target === 1 ? 0 : z.tx, target === 1 ? 0 : z.ty)
    showZoomHud()
  }
  // Click on empty stage area closes; a pan suppresses it; clicks on the image don't close.
  const onStageClick = (e: React.MouseEvent) => {
    e.stopPropagation()
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
        {src ? <img className={[css.image, mediaClass].filter(Boolean).join(' ')} data-testid="viewer-image" src={src} alt={alt} draggable={false}
          style={{ width: sideways ? fit?.h : fit?.w, height: sideways ? fit?.w : fit?.h, transform: 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + scale + ')' + (rotation ? ' rotate(' + rotation + 'deg)' : ''), willChange: 'transform' }}
          onLoad={e => { const el = e.currentTarget; setNat({ w: el.naturalWidth, h: el.naturalHeight }) }}
        /> : <div className={css.missing}>{localeText('无法读取这张图片', 'Unable to load this image')}</div>}
      </div>
      {zoomHudVisible && (
        <div className={css.zoomHud} data-testid="viewer-zoom-hud" aria-hidden="true">{percent}%</div>
      )}
      {(hasNav || onBackToList) && (
        <div className={css.topbar}>
          <div className={css.navBar} onPointerDown={e => e.stopPropagation()}>
            {hasNav && onPrev && <button type="button" className={css.ctrl} data-testid="viewer-prev" disabled={index! <= 0} onClick={onPrev}>{labels.prev || localeText('上一张', 'Previous')}</button>}
            {hasNav && <span className={css.counter}>{index! + 1} / {count}</span>}
            {hasNav && onNext && <button type="button" className={css.ctrl} data-testid="viewer-next" disabled={index! >= count! - 1} onClick={onNext}>{labels.next || localeText('下一张', 'Next')}</button>}
            {onBackToList && <button type="button" className={css.ctrl} onClick={onBackToList}>{labels.backToList || localeText('返回列表', 'Back to list')}</button>}
          </div>
        </div>
      )}
      <div className={css.headerActions}>
        {src && <>
          <MediaInvertButton pressed={inverted} className={css.ctrl} />
          <MediaRotateButton className={css.ctrl} onRotate={props.onRotate ?? (() => setImageRotation({
            key: resetKey, angle: (rotation + 90) % 360,
          }))} />
        </>}
        {headerAction}
        <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>✕</button>
      </div>
    </div>,
    document.body,
  )
}
