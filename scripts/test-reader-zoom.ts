import {
  READER_ZOOM_MAX,
  READER_ZOOM_MIN,
  clampReaderZoom,
  readerZoomFromWheel,
  stepReaderZoom,
} from '../src/documents/reader-zoom.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

assert(clampReaderZoom(0.01) === READER_ZOOM_MIN, 'zoom is clamped to the 40% minimum')
assert(clampReaderZoom(8) === READER_ZOOM_MAX, 'zoom is clamped to the 250% maximum')
assert(clampReaderZoom(Number.NaN) === 1, 'invalid zoom values safely reset to 100%')
assert(stepReaderZoom(1, -1) === 0.9, 'zoom-out button uses a fine 10% step')
assert(stepReaderZoom(1, 1) === 1.1, 'zoom-in button uses a fine 10% step')

const trackpadZoom = readerZoomFromWheel(1, -17)
assert(trackpadZoom > 1 && trackpadZoom < 1.03, 'small trackpad deltas produce smooth sub-step zoom')
assert(readerZoomFromWheel(1, -120) > 1, 'negative wheel delta zooms in')
assert(readerZoomFromWheel(1, 120) < 1, 'positive wheel delta zooms out')
assert(readerZoomFromWheel(READER_ZOOM_MAX, -1000) === READER_ZOOM_MAX, 'wheel zoom respects the upper bound')
assert(readerZoomFromWheel(READER_ZOOM_MIN, 1000) === READER_ZOOM_MIN, 'wheel zoom respects the lower bound')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
