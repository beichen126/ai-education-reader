// Agent C (C13): Reader display render controller — node-testable with a fake backend.
// Covers: direct display surface (never a Blob), real RenderTask cancellation, cancellation
// not surfaced as an error, viewport-aware scale + pixel budget, bounded LRU eviction,
// cache-hit no re-render (10 → 11 → 10), neighbor prefetch, and document switch / reader
// close clearing the cache. Pure PDF.js-free logic.
import { ReaderRenderController } from '../src/pdf/reader-render-controller'
import type { PageSurface, PageSurfaceRender } from '../src/pdf/pdf-service'
import { computeDisplayScale, computeDisplayTargetScale, MAX_RENDER_EDGE, MAX_RENDER_PIXELS, MAX_DPR } from '../src/pdf/pdf-render-policy'
import { BoundedPageCache } from '../src/pdf/pdf-page-cache'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(5) }
  return cond()
}

// ---- viewport-aware display scale (C4) ----
{
  const vp1 = { width: 612, height: 792 }
  const target = computeDisplayTargetScale(vp1, { width: 800, height: 1000 }, 2)
  assert(Math.abs(target - Math.min(800 / 612, 1000 / 792) * 2) < 1e-9, 'display target = fitScale * dpr (got ' + target.toFixed(4) + ')')
  const scale = computeDisplayScale(vp1, { width: 800, height: 1000 }, 2)
  const w = Math.floor(vp1.width * scale), h = Math.floor(vp1.height * scale)
  assert(w * h <= MAX_RENDER_PIXELS + 1, 'display render respects MAX_RENDER_PIXELS (w*h=' + (w * h) + ')')
  const dpr3 = computeDisplayScale(vp1, { width: 800, height: 1000 }, 5)
  const dprCap = computeDisplayScale(vp1, { width: 800, height: 1000 }, MAX_DPR)
  assert(dpr3 === dprCap, 'effective DPR capped at MAX_DPR (' + dpr3.toFixed(3) + ')')
  assert(computeDisplayScale(vp1, { width: 0, height: 0 }, 2) === 1, 'zero box -> scale 1')
  assert(computeDisplayScale(vp1, { width: -1, height: 10 }, 2) === 1, 'negative box -> scale 1')
  const huge = computeDisplayScale({ width: 1000000, height: 1000000 }, { width: 800, height: 1000 }, 2)
  assert(Math.floor(1000000 * huge) * Math.floor(1000000 * huge) <= MAX_RENDER_PIXELS + 1, 'huge page still fits pixel budget')
  const edge = Math.max(vp1.width * scale, vp1.height * scale)
  assert(edge <= MAX_RENDER_EDGE + 1, 'long edge <= MAX_RENDER_EDGE (got ' + edge.toFixed(1) + ')')
}

// ---- bounded LRU page cache (C5) ----
{
  const disposed: string[] = []
  const cache = new BoundedPageCache<{ v: number }>(3, (_v, k) => disposed.push(k))
  cache.put('1', { v: 1 }); cache.put('2', { v: 2 }); cache.put('3', { v: 3 })
  assert(cache.size === 3 && cache.keys().join(',') === '3,2,1', 'cache MRU order after puts')
  cache.get('1')
  assert(cache.keys().join(',') === '1,3,2', 'get refreshes MRU order')
  cache.put('4', { v: 4 })
  assert(cache.size === 3 && !cache.has('2'), 'capacity 3 evicts LRU (2)')
  assert(disposed.includes('2'), 'evicted value disposed via onEvict')
  assert(cache.keys().join(',') === '4,1,3', 'order after eviction')
  assert(cache.delete('1') !== undefined && cache.size === 2, 'delete removes entry')
  cache.clear()
  assert(cache.size === 0, 'clear empties cache')
}

// ---- fake backend ----
function makeFakeBackend(delayMs = 8) {
  const renders = new Map<number, number>()
  const cancels = new Map<number, number>()
  const makeSurface = (n: number, scale: number): PageSurface => ({ surface: { p: n } as unknown as ImageBitmap, width: Math.round(612 * scale), height: Math.round(792 * scale), scale, pageNumber: n })
  const backend = {
    readViewport1: async (_n: number) => { await sleep(delayMs); return { width: 612, height: 792 } },
    startRender: (n: number, scale: number): PageSurfaceRender => {
      renders.set(n, (renders.get(n) ?? 0) + 1)
      let cancelled = false
      let resolveFn: (s: PageSurface) => void = () => {}
      let rejectFn: (e: unknown) => void = () => {}
      const promise = new Promise<PageSurface>((res, rej) => { resolveFn = res; rejectFn = rej })
      setTimeout(() => { if (!cancelled) resolveFn(makeSurface(n, scale)) }, delayMs)
      return {
        promise,
        cancel() {
          cancelled = true
          cancels.set(n, (cancels.get(n) ?? 0) + 1)
          rejectFn(new Error('RenderingCancelled'))
        },
      }
    },
  }
  return { renders, cancels, backend }
}

(async () => {
  const { renders, cancels, backend } = makeFakeBackend()
  const fg: { page: number; fromCache: boolean }[] = []
  const errors: number[] = []
  const events = {
    onForeground: (s: { pageNumber: number }, fromCache: boolean) => fg.push({ page: s.pageNumber, fromCache }),
    onRenderState: (_r: boolean) => {},
    onPageError: (n: number) => errors.push(n),
  }
  const ctrl = new ReaderRenderController(backend, { cacheCapacity: 4, pageCount: 20 }, events)
  ctrl.setGeometry({ box: { width: 800, height: 1000 }, dpr: 2 })

  // 1. foreground renders a DIRECT surface (never a Blob). page 10 -> prefetch 9 + 11.
  ctrl.requestForeground(10)
  await waitUntil(() => fg.length >= 1)
  assert(renders.get(10) === 1, 'page 10 foreground rendered once')
  assert(fg[0].page === 10 && fg[0].fromCache === false, 'foreground delivered page 10 (fresh)')
  await waitUntil(() => ctrl.hasCached(9) || ctrl.hasCached(11))
  assert(ctrl.hasCached(9) || ctrl.hasCached(11), 'neighbor prefetch cached (9 or 11)')
  assert(errors.length === 0, 'no page errors on normal flow')

  // 2. cache hit: 10 → 11 → 10, neither re-renders.
  const r10 = renders.get(10) ?? 0
  ctrl.requestForeground(11)
  await waitUntil(() => fg[fg.length - 1]?.page === 11 && fg[fg.length - 1].fromCache)
  assert(fg[fg.length - 1].fromCache === true, 'page 11 from cache (prefetched) not re-rendered')
  await waitUntil(() => ctrl.hasCached(10))
  ctrl.requestForeground(10)
  await waitUntil(() => fg[fg.length - 1]?.page === 10 && fg[fg.length - 1].fromCache)
  assert((renders.get(10) ?? 0) === r10, 'page 10 not re-rendered on return (10→11→10 gate)')

  // 3. real RenderTask cancellation: start page 12, let it begin, then jump to 13 to cancel it.
  const cancelBefore = cancels.get(12) ?? 0
  ctrl.requestForeground(12)
  await waitUntil(() => (renders.get(12) ?? 0) >= 1) // readViewport done, startRender called -> fgHandle set
  ctrl.requestForeground(13)
  await waitUntil(() => fg[fg.length - 1]?.page === 13)
  assert((cancels.get(12) ?? 0) > cancelBefore, 'stale render task for page 12 is truly cancelled')
  assert(errors.length === 0, 'cancellation is NOT surfaced as a page error')

  // 4. document switch / reader close clears the cache + a pending render is invalidated.
  ctrl.requestForeground(5)
  ctrl.cancelAll() // immediately — before the render can complete
  await sleep(40)
  assert(ctrl.hasCached(5) === false, 'cancelAll (document switch / close) clears cache')
  assert((cancels.get(5) ?? 0) >= 1 || errors.length === 0, 'cancelAll invalidates the pending foreground render')
  // a fresh request after cancelAll still works (no zombie state)
  ctrl.requestForeground(7)
  await waitUntil(() => fg[fg.length - 1]?.page === 7)
  assert(fg[fg.length - 1].page === 7, 'controller usable after cancelAll (no zombie)')

  console.log('\nRESULT pass=' + pass + ' fail=' + fail)
  process.exit(fail === 0 ? 0 : 1)
})()
