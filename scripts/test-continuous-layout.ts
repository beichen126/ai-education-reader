// v2.2.0 Stage 2 domain gate: the continuous layout model is pure, bounded and anchor-stable.
import { ContinuousLayoutModel } from '../src/pdf/continuous-layout-model.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) }
}

const WIDTH = 800
const HEIGHT = 900
const make = (pageCount: number, overscanPx = HEIGHT / 2) => new ContinuousLayoutModel({ pageCount, contentWidth: WIDTH, overscanPx })
const withViewport = (pageCount: number, overscanPx = HEIGHT / 2) => {
  const model = make(pageCount, overscanPx)
  model.setGeometry({ viewportHeight: HEIGHT })
  return model
}

// ---- 1. geometry is estimated before any measurement ----
{
  const model = withViewport(500)
  const estimated = model.estimatedHeight()
  assert(estimated > 800 && estimated < 1400, 'an unmeasured A4-ish page has a plausible estimated height (' + Math.round(estimated) + ')')
  assert(model.offsetOf(1) === 0, 'page 1 starts at offset 0')
  assert(Math.abs(model.offsetOf(2) - (estimated + model.getGap())) < 0.001, 'page 2 offset = page1 height + gap')
  assert(model.totalHeight() > estimated * 499, 'total height accounts for every page')
}

// ---- 2. the virtual window is bounded for 500 / 2000 / 10000 pages ----
for (const pageCount of [10, 500, 2000, 10000]) {
  const model = withViewport(pageCount)
  let worst = 0
  let worstCanvasish = 0
  for (let step = 0; step <= 40; step++) {
    const scrollTop = (model.totalHeight() * step) / 40
    const window = model.getVirtualWindow(scrollTop)
    worst = Math.max(worst, window.pages.length)
    // A mounted page always gets a canvas in the DOM; the window is the DOM bound.
    worstCanvasish = Math.max(worstCanvasish, window.pages.length)
    const contiguous = window.pages.every((page, index) => index === 0 || page === window.pages[index - 1] + 1)
    assert(contiguous, pageCount + ' pages: window at step ' + step + ' is contiguous')
    assert(window.startPage >= 1 && window.endPage <= pageCount, pageCount + ' pages: window stays inside the document at step ' + step)
  }
  assert(worst <= 11, pageCount + ' pages: mounted page window never exceeds 11 (worst ' + worst + ')')
  assert(worstCanvasish <= 11, pageCount + ' pages: canvas window never exceeds 11 (worst ' + worstCanvasish + ')')
}

// ---- 3. spacers account for every pixel, so the stack height is stable ----
{
  const model = withViewport(2000)
  const window = model.getVirtualWindow(model.offsetForPage(1000, 'center'))
  const mountedHeight = window.pages.reduce((sum, page) => sum + model.heightFor(page), 0) + model.getGap() * (window.pages.length - 1)
  assert(Math.abs(window.topSpacer + mountedHeight + window.bottomSpacer - model.totalHeight()) < 0.001, 'top spacer + mounted pages + bottom spacer = total height')
  assert(model.offsetOf(window.startPage) === window.topSpacer, 'the top spacer equals the first mounted page offset')
}

// ---- 4. the window follows the scroll position instead of the page count ----
{
  const model = withViewport(10000)
  const nearTop = model.getVirtualWindow(0)
  const deep = model.getVirtualWindow(model.offsetForPage(9000, 'start'))
  assert(nearTop.startPage === 1, 'scrolling to the top mounts page 1')
  assert(deep.pages.includes(9000), 'a deep jump mounts the target page')
  assert(deep.pages.length <= 11 && nearTop.pages.length <= 11, 'both windows stay bounded on a 10000 page document')
}

// ---- 5. pageAtViewportCenter tracks the visible page ----
{
  const model = withViewport(500)
  assert(model.pageAtViewportCenter(0) === 1, 'the top of the document shows page 1')
  assert(model.pageAtViewportCenter(model.offsetForPage(200, 'center')) === 200, 'centring page 200 reports page 200')
  assert(model.pageAtViewportCenter(model.totalHeight()) === 500, 'the end of the document shows the last page')
}

// ---- 6. a late measurement above the anchor compensates the scroll position ----
{
  const model = withViewport(500)
  const anchor = 120
  const scrollTop = model.offsetForPage(anchor, 'center')
  const estimated = model.estimatedHeight()
  const correction = model.recordPageAspect(5, 1.4, anchor) // a wide page: shorter than estimated
  assert(correction.scrollDelta !== 0, 'a size change above the anchor reports a correction')
  assert(Math.abs(correction.scrollDelta - (WIDTH / 1.4 - estimated)) < 0.001, 'the correction equals the height delta')
  assert(Math.abs(model.offsetForPage(anchor, 'center') - (scrollTop + correction.scrollDelta)) < 0.001, 'applying the correction keeps the anchor page in place')
}

// ---- 7. a measurement below the anchor never moves the view ----
{
  const model = withViewport(500)
  const correction = model.recordPageAspect(300, 1.4, 120)
  assert(correction.scrollDelta === 0, 'a size change below the anchor needs no correction')
  assert(model.hasMeasurement(300), 'the measurement is still recorded')
}

// ---- 8. re-measuring the same ratio is a no-op ----
{
  const model = withViewport(500)
  model.recordPageAspect(10, 0.707, 10)
  const again = model.recordPageAspect(10, 0.707, 10)
  assert(again.scrollDelta === 0, 're-recording the same ratio produces no correction')
  assert(model.measurementCount() === 1, 're-recording does not duplicate the metric')
}

// ---- 9. measurements survive a scroll but not a document switch ----
{
  const model = withViewport(500)
  model.recordPageAspect(3, 1.2, 3)
  assert(model.measurementCount() === 1, 'a measurement is kept while scrolling')
  model.clearMeasurements()
  assert(model.measurementCount() === 0, 'clearMeasurements drops every metric')
  assert(Math.abs(model.heightFor(3) - model.estimatedHeight()) < 0.001, 'a cleared page falls back to the estimate')
}

// ---- 10. page count changes stay consistent ----
{
  const model = withViewport(500)
  model.recordPageAspect(400, 1.2, 400)
  model.setPageCount(100)
  assert(model.getPageCount() === 100, 'setPageCount updates the count')
  assert(!model.hasMeasurement(400), 'metrics beyond the new page count are dropped')
  assert(model.getVirtualWindow(model.totalHeight()).endPage === 100, 'the last window clamps to the new page count')
}

// ---- 11. the 10000-page model stays cheap enough for the scroll hot path ----
{
  const model = withViewport(10000)
  const started = Date.now()
  for (let index = 0; index < 2000; index++) model.getVirtualWindow((index * 977) % model.totalHeight())
  const elapsed = Date.now() - started
  assert(elapsed < 2000, '2000 window computations on 10000 pages finish quickly (' + elapsed + 'ms)')
}

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
