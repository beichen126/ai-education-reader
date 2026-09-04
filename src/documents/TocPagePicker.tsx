// TOC page picker (Stage 9.4C.1): choose the PDF pages that contain the printed table
// of contents. Thumbnails render lazily via IntersectionObserver into a small
// concurrency-limited queue (never every page, never a 30-at-once burst), are
// LOW-RESOLUTION (shared render core with a 260px long edge), use short-lived object
// URLs that are revoked on unmount/cancel, and are NEVER persisted or sent anywhere.
// Selection = a set of physical pages.
import { useEffect, useMemo, useRef, useState } from 'react'
import { renderSessionThumbnail } from '../pdf/pdf-session'
import type { PdfSession } from '../pdf/pdf-session'
import css from './toc-page-picker.module.css'

const INITIAL_BATCH = 30
const BATCH_STEP = 30
const THUMB_EDGE = 260
const MAX_THUMB_RENDER_CONCURRENCY = 3

type Props = {
  session: PdfSession
  pageCount: number
  pagesByPage?: (n: number) => void
  onCancel: () => void
  onStart: (selectedPages: number[]) => void
}

export function TocPagePicker({ session, pageCount, onCancel, onStart }: Props) {
  const [loadedCount, setLoadedCount] = useState(INITIAL_BATCH)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  // Finding 9.4D.2-0.6.15: range + drag selection, and a "连续选择" mode toggle for touch.
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [continuousMode, setContinuousMode] = useState(false)
  const dragRef = useRef<{ anchor: number; mode: 'add' | 'remove'; snapshot: Set<number> } | null>(null)
  const urlOwnerRef = useRef<string[]>([])
  const genRef = useRef(0)
  const renderedRef = useRef<Set<number>>(new Set())
  const pendingRef = useRef<Set<number>>(new Set())
  const inFlightRef = useRef(0)
  const queueRef = useRef<number[]>([]);
  const enqueueRef = useRef<(n: number) => void>(() => {});
  const observerRef = useRef<IntersectionObserver | null>(null);
  const thumbRefs = useRef<Record<number, HTMLElement | null>>({})

  const revoke = (url: string) => { try { URL.revokeObjectURL(url) } catch {} };

  // Revoke all thumbnails + invalidate the queue on unmount.
  useEffect(() => () => { genRef.current++; observerRef.current?.disconnect(); for (const u of urlOwnerRef.current) revoke(u); urlOwnerRef.current = []; pendingRef.current.clear(); queueRef.current = []; renderedRef.current.clear() }, [])

  // A bounded render worker: pulls the next queued page and renders ONE thumbnail.
  const pump = useRef<() => void>(() => {});
  pump.current = () => {
    if (inFlightRef.current >= MAX_THUMB_RENDER_CONCURRENCY) return
    const gen = genRef.current
    const next = queueRef.current.shift();
    if (next == null) return
    pendingRef.current.add(next)
    inFlightRef.current++;
    void (async () => {
      try {
        const r = await renderSessionThumbnail(session, next, THUMB_EDGE);
        if (gen !== genRef.current) { revoke(URL.createObjectURL(r.blob)); return }
        const url = URL.createObjectURL(r.blob);
        if (renderedRef.current.has(next)) { revoke(url); return }
        renderedRef.current.add(next);
        urlOwnerRef.current.push(url);
        // Render-count instrumentation (finding 9.4D.2-0.1) so an e2e can prove a revisited
        // page is rendered EXACTLY once. Harmless in production (no allocation churn).
        const g = (globalThis as any).__dshThumbRenderCounts || ((globalThis as any).__dshThumbRenderCounts = {});
        g[next] = (g[next] || 0) + 1;
        setThumbs(prev => (prev[next] ? prev : { ...prev, [next]: url }));
      } catch { /* leave blank */ }
      finally { inFlightRef.current--; pendingRef.current.delete(next); pump.current() }
    })();
  };

  // Lazily enqueue a page once it enters the viewport (with a small preload margin).
  // Uses ONLY live refs — never a closed-over render value.
  const enqueue = (n: number) => {
    if (renderedRef.current.has(n)) return
    if (pendingRef.current.has(n)) return
    queueRef.current.push(n);
    pendingRef.current.add(n);
    pump.current();
  };
  enqueueRef.current = enqueue;

  // Set up an IntersectionObserver over the visible thumb slots.
  useEffect(() => {
    const gen = genRef.current
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { const n = Number((e.target as HTMLElement).dataset.page); if (n) enqueueRef.current(n) }
      }
    }, { rootMargin: '120px' });
    observerRef.current = io;
    // Observe all currently-rendered slots synchronously.
    for (let n = 1; n <= Math.min(loadedCount, pageCount); n++) { const el = thumbRefs.current[n]; if (el) io.observe(el) }
    return () => { io.disconnect(); observerRef.current = null };
  }, [loadedCount, pageCount]); // eslint-disable-line

  const sorted = useMemo(() => Array.from(selected).sort((a, b) => a - b), [selected])
  const toggle = (n: number) => { setRangeError(null); setSelected(prev => { const next = new Set(prev); if (next.has(n)) next.delete(n); else next.add(n); return next }) }
  const ensureLoaded = (end: number) => { if (end > loadedCount) setLoadedCount(Math.min(end, pageCount)) }
  const selectRange = () => {
    setRangeError(null)
    const s = Number(rangeStart.trim()), e = Number(rangeEnd.trim())
    if (rangeStart.trim() === '' || rangeEnd.trim() === '' || !Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < 1 || s > pageCount || e > pageCount || s > e) {
      setRangeError('请输入 1–' + pageCount + ' 之间的有效页码范围。'); return
    }
    setSelected(prev => { const next = new Set(prev); for (let n = s; n <= e; n++) next.add(n); return next })
    ensureLoaded(e)
    setRangeStart(''); setRangeEnd('')
    setTimeout(() => scrollToStart(s), 50)
  }
  const clearSelection = () => { setRangeError(null); setSelected(new Set()) }
  const dragStart = (n: number) => { dragRef.current = { anchor: n, mode: selected.has(n) ? 'remove' : 'add', snapshot: new Set(selected) } }
  const dragOver = (n: number) => {
    const d = dragRef.current; if (!d) return
    const start = Math.min(d.anchor, n), end = Math.max(d.anchor, n)
    setSelected(() => { const next = new Set(d.snapshot); for (let k = start; k <= end; k++) { if (d.mode === 'add') next.add(k); else next.delete(k) } return next })
    ensureLoaded(end)
  }
  const dragEnd = () => { dragRef.current = null }
  const scrollToStart = (s: number) => { const el = thumbRefs.current[s]; if (el) el.scrollIntoView({ block: 'start' }) }

  const selectedText = useMemo(() => {
    if (sorted.length === 0) return '未选择'
    const ranges: { start: number; end: number }[] = []
    for (const n of sorted) { const last = ranges[ranges.length - 1]; if (last && n === last.end + 1) last.end = n; else ranges.push({ start: n, end: n }) }
    return ranges.map(r => r.start === r.end ? String(r.start) : (r.start + '–' + r.end)).join('、')
  }, [sorted])

  return (
    <div className={css.overlay} data-testid="toc-picker">
      <div className={css.panel}>
        <div className={css.header}>
          <div className={css.headRow}>
            <span className={css.title}>选择目录页</span>
            <div className={css.headerBtns}>
              <button type="button" className={css.btn} data-testid="toc-picker-cancel" onClick={onCancel}>取消</button>
              <button type="button" className={css.btnPrimary} data-testid="toc-picker-start" disabled={selected.size === 0} onClick={() => onStart(sorted)}>开始识别{selected.size ? '（' + selected.size + ' 页）' : ''}</button>
            </div>
          </div>
          <div className={css.rangeRow} data-testid="toc-picker-range">
            <label className={css.rangeLabel}>PDF页范围</label>
            <input className={css.rangeInput} data-testid="toc-picker-range-start" inputMode="numeric" aria-label="起始页" placeholder="起始" value={rangeStart} onChange={e => setRangeStart(e.target.value)} />
            <span className={css.rangeSep}>—</span>
            <input className={css.rangeInput} data-testid="toc-picker-range-end" inputMode="numeric" aria-label="结束页" placeholder="结束" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)} />
            <button type="button" className={css.btn} data-testid="toc-picker-range-apply" onClick={selectRange}>选择范围</button>
            <button type="button" className={css.btn + (continuousMode ? ' ' + css.btnOn : '')} data-testid="toc-picker-continuous" onClick={() => setContinuousMode(v => !v)}>{continuousMode ? '连续选择：开启' : '连续选择'}</button>
            <button type="button" className={css.btn} data-testid="toc-picker-clear" onClick={clearSelection}>清空</button>
          </div>
          {rangeError && <div className={css.rangeErr} data-testid="toc-picker-range-error">{rangeError}</div>}
          <div className={css.pickCount} data-testid="toc-picker-count">已选择 {sorted.length} 页 · PDF {selectedText || '—'}</div>
        </div>
        <div className={css.privacy} data-testid="toc-picker-privacy">仅你选择的目录页面图片会发送到当前配置的视觉模型；完整 PDF 不会因此上传。</div>
        <div className={css.grid} data-testid="toc-picker-grid">
          {Array.from({ length: Math.min(loadedCount, pageCount) }, (_, i) => i + 1).map(n => (
            <button key={n} type="button" ref={(el) => { thumbRefs.current[n] = el }} className={css.thumb + (selected.has(n) ? ' ' + css.selected : '')} data-testid={'toc-thumb-' + n} data-page={n} data-selected={selected.has(n) ? '1' : '0'}
              onClick={() => toggle(n)}
              onPointerDown={(e) => { if (continuousMode || e.pointerType === 'mouse') { e.preventDefault(); dragStart(n) } }}
              onPointerEnter={(e) => { if (dragRef.current) dragOver(n) }}
              onPointerUp={() => dragEnd()}>
              <span className={css.thumbNum}>{n}</span>
              {thumbs[n] ? <img className={css.thumbImg} src={thumbs[n]} alt={'第 ' + n + ' 页'} /> : <span className={css.thumbLoad}>…</span>}
              <span className={css.check}>{selected.has(n) ? '✓' : ''}</span>
            </button>
          ))}
        </div>
        {loadedCount < pageCount && (
          <div className={css.footer}>
            <button type="button" className={css.btn} data-testid="toc-picker-more" onClick={() => setLoadedCount(c => Math.min(c + BATCH_STEP, pageCount))}>继续加载 {Math.min(BATCH_STEP, pageCount - loadedCount)} 页</button>
            <span className={css.footerHint}>已加载 {Math.min(loadedCount, pageCount)} / {pageCount} 页</span>
          </div>
        )}
        {loadedCount >= pageCount && <div className={css.footer}><span className={css.footerHint}>已加载全部 {pageCount} 页</span></div>}
      </div>
    </div>
  )
}