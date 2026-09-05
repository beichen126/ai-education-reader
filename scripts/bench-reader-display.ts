// Agent C (C12): Reader display pipeline structural benchmark. NO hardware-bound
// gate — it reports structural stats (foreground renders, prefetch renders, cancellations,
// cache hits/misses) for the navigation patterns in the spec: forward 10 pages, 10→11→10
// (cache revisit), and a rapid 5-page flip. A meaningful "before" would render + JPEG-encode
// EVERY visited page and never cancel a stale RenderTask; this reports that naive count as a
// baseline so the improvement is visible without a timing gate.
//
// Run: npx tsx scripts/bench-reader-display.ts
import { ReaderRenderController } from '../src/pdf/reader-render-controller'
import type { PageSurface, PageSurfaceRender } from '../src/pdf/pdf-service'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(5) }
  return cond()
}

function makeBackend(delayMs = 10) {
  const makeSurface = (n: number, scale: number): PageSurface => ({ surface: { p: n } as unknown as ImageBitmap, width: Math.round(612 * scale), height: Math.round(792 * scale), scale, pageNumber: n })
  const renders = new Map<number, number>()
  const cancels = new Map<number, number>()
  const backend = {
    readViewport1: async (_n: number) => { await sleep(delayMs); return { width: 612, height: 792 } },
    startRender: (n: number, scale: number): PageSurfaceRender => {
      renders.set(n, (renders.get(n) ?? 0) + 1)
      let cancelled = false
      let resolveFn: (s: PageSurface) => void = () => {}
      let rejectFn: (e: unknown) => void = () => {}
      const promise = new Promise<PageSurface>((res, rej) => { resolveFn = res; rejectFn = rej })
      setTimeout(() => { if (!cancelled) resolveFn(makeSurface(n, scale)) }, delayMs)
      return { promise, cancel() { cancelled = true; cancels.set(n, (cancels.get(n) ?? 0) + 1); rejectFn(new Error('RenderingCancelled')) } }
    },
  }
  return { backend, renders, cancels }
}

function freshController(backend: ReturnType<typeof makeBackend>['backend']) {
  const fg: { page: number }[] = []
  const ctrl = new ReaderRenderController(backend, { cacheCapacity: 5, pageCount: 60 }, {
    onForeground: (s) => fg.push({ page: s.pageNumber }),
    onRenderState: () => {},
    onPageError: () => {},
  })
  ctrl.setGeometry({ box: { width: 800, height: 1000 }, dpr: 2 })
  return { ctrl, fg }
}

async function runCase(name: string, fn: (ctrl: ReaderRenderController, fg: { page: number }[]) => Promise<void>, totalPages: number) {
  const { backend, renders, cancels } = makeBackend()
  const { ctrl, fg } = freshController(backend)
  await fn(ctrl, fg)
  const stats = ctrl.getStats()
  const naive = totalPages
  console.log('--- ' + name + ' ---')
  console.log('  foreground renders: ' + stats.renders + '   prefetch renders: ' + stats.prefetchRenders)
  console.log('  cache hits: ' + stats.cacheHits + '   cache misses: ' + stats.cacheMisses)
  console.log('  cancelled stale RenderTasks: ' + stats.cancels)
  console.log('  naive baseline (render + JPEG-encode every visited page): ' + naive)
  console.log('  page render map: ' + [...renders.entries()].sort((a, b) => a[0] - b[0]).map(([p, c]) => p + ':' + c).join(' '))
}

// 1. Forward 10 pages (user pauses to read, so the neighbor prefetch completes and the
//    next page is already ready when they click 下一页 — the "click → 11 already ready" goal).
await runCase('forward 1→10 (read-then-advance)', async (ctrl) => {
  for (let p = 1; p <= 10; p++) {
    ctrl.requestForeground(p)
    await waitUntil(() => ctrl.hasCached(p))
    if (p < 10) await waitUntil(() => ctrl.hasCached(p + 1)) // prefetch done while "reading"
  }
}, 10)

// 2. 10 → 11 → 10 (cache revisit should not re-render page 10)
await runCase('10 → 11 → 10', async (ctrl, fg) => {
  ctrl.requestForeground(10); await waitUntil(() => ctrl.hasCached(10))
  ctrl.requestForeground(11); await waitUntil(() => ctrl.hasCached(11))
  ctrl.requestForeground(10); await waitUntil(() => ctrl.hasCached(10))
}, 3)

// 3. Rapid 10 → 11 → 12 → 13 → 14 (no awaits between)
await runCase('rapid 10→14', async (ctrl) => {
  ctrl.requestForeground(10)
  ctrl.requestForeground(11)
  ctrl.requestForeground(12)
  ctrl.requestForeground(13)
  ctrl.requestForeground(14)
  await waitUntil(() => ctrl.hasCached(14))
}, 5)

const src = await import('node:fs').then(fs => fs.readFileSync('src/documents/DocumentReader.tsx', 'utf8'))
const bodyPath = src.includes('useReaderDisplay')
const noToBlob = !src.includes("toBlob")
console.log('\n--- structural gates ---')
console.log('  Reader正文 uses useReaderDisplay (canvas) : ' + (bodyPath ? 'YES' : 'NO'))
console.log('  Reader正文 calls canvas.toBlob:           : ' + (noToBlob ? 'NO' : 'YES'))
console.log('\nDone.')
