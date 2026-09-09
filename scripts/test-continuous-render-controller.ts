// Stage 8 domain gate: the continuous renderer owns only a bounded virtual
// window, coalesces duplicate viewport reads, cancels stale render tasks, and
// releases all cached surfaces on close.
import { ContinuousRenderController } from '../src/pdf/continuous-render-controller'
import type { PageSurface, PageSurfaceRender } from '../src/pdf/pdf-service'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string) => {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitUntil(condition: () => boolean, timeoutMs = 2500): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true
    await sleep(5)
  }
  return condition()
}

function makeBackend() {
  const reads = new Map<number, number>()
  const renders = new Map<number, number>()
  const cancels = new Map<number, number>()
  let disposed = 0
  const makeSurface = (pageNumber: number, scale: number): PageSurface => ({
    surface: { close: () => { disposed++ } } as unknown as ImageBitmap,
    width: Math.round(612 * scale),
    height: Math.round(792 * scale),
    scale,
    pageNumber,
  })
  const backend = {
    readViewport1: async (pageNumber: number) => {
      reads.set(pageNumber, (reads.get(pageNumber) ?? 0) + 1)
      await sleep(8)
      return { width: 612, height: 792 }
    },
    startRender: (pageNumber: number, scale: number): PageSurfaceRender => {
      renders.set(pageNumber, (renders.get(pageNumber) ?? 0) + 1)
      let cancelled = false
      let resolvePromise: (surface: PageSurface) => void = () => {}
      let rejectPromise: (reason: unknown) => void = () => {}
      const promise = new Promise<PageSurface>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
      })
      const timer = setTimeout(() => { if (!cancelled) resolvePromise(makeSurface(pageNumber, scale)) }, 8)
      return {
        promise,
        cancel() {
          cancelled = true
          clearTimeout(timer)
          cancels.set(pageNumber, (cancels.get(pageNumber) ?? 0) + 1)
          rejectPromise(new Error('RenderingCancelled'))
        },
      }
    },
  }
  return { backend, reads, renders, cancels, getDisposed: () => disposed }
}

(async () => {
  const fake = makeBackend()
  const ready: number[] = []
  const errors: number[] = []
  const controller = new ContinuousRenderController(fake.backend, { pageCount: 500, cacheCapacity: 11 }, {
    onPageReady: page => ready.push(page),
    onPageEvicted: () => {},
    onPageViewport: () => {},
    onPageError: page => errors.push(page),
    onRendering: () => {},
  })
  controller.setGeometry({ box: { width: 800, height: 900 }, dpr: 1 })

  controller.setTargetPages([1])
  controller.setTargetPages([1])
  controller.setTargetPages([1])
  await waitUntil(() => ready.includes(1))
  assert((fake.reads.get(1) ?? 0) === 1, 'duplicate target updates coalesce the pending viewport read')
  assert((fake.renders.get(1) ?? 0) === 1, 'one target starts exactly one render')

  const cancelBefore = fake.cancels.get(2) ?? 0
  controller.setTargetPages([2])
  await waitUntil(() => (fake.renders.get(2) ?? 0) >= 1)
  controller.setTargetPages([3])
  await waitUntil(() => ready.includes(3))
  assert((fake.cancels.get(2) ?? 0) > cancelBefore, 'off-window render task is cancelled')
  assert(errors.length === 0, 'stale cancellation is not surfaced as a page error')

  const beforeWindow = ready.length
  controller.setTargetPages(Array.from({ length: 11 }, (_, index) => 100 + index))
  await waitUntil(() => ready.filter(page => page >= 100 && page <= 110).length >= 11)
  const bounded = controller.getStats()
  assert(bounded.cacheSize <= 11 && bounded.cacheCapacity === 11, '500-page document keeps the surface cache bounded at 11')
  assert(ready.length > beforeWindow, 'jumping to page 100 renders the new virtual window')

  controller.setTargetPages(Array.from({ length: 11 }, (_, index) => 490 + index))
  await waitUntil(() => ready.filter(page => page >= 490 && page <= 500).length >= 11)
  assert(controller.getStats().cacheSize <= 11, 'jumping to page 500 never grows the cache beyond 11 surfaces')
  controller.cancelAll()
  await sleep(15)
  assert(controller.getStats().cacheSize === 0 && fake.getDisposed() > 0, 'close clears cached surfaces and releases backing resources')

  console.log('\nRESULT pass=' + pass + ' fail=' + fail)
  process.exit(fail === 0 ? 0 : 1)
})()
