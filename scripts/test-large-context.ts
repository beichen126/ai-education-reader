// Local PDF page safeguards and the documented DeepSeek image count (not OpenAI).
import { needsPdfContextSoftConfirm, exceedsPdfContextHardLimit, PDF_CONTEXT_SOFT_WARNING_PAGES, MAX_PDF_CONTEXT_PAGES } from '../src/pdf/pdf-types.ts'
import { exceedsVisionImageCount, MAX_VISION_IMAGES_PER_REQUEST } from '../src/api/deepseek.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// page soft confirm: 30 no, 31 yes, 80 yes, 120 yes
assert(needsPdfContextSoftConfirm(30) === false, '30 pages -> no soft confirm')
assert(needsPdfContextSoftConfirm(31) === true, '31 pages -> soft confirm')
assert(needsPdfContextSoftConfirm(80) === true, '80 pages -> soft confirm')
assert(needsPdfContextSoftConfirm(120) === true, '120 pages -> soft confirm (allowed)')
// hard limit: 120 ok, 121 blocked, 130 blocked
assert(exceedsPdfContextHardLimit(120) === false, '120 pages -> NOT over hard limit')
assert(exceedsPdfContextHardLimit(121) === true, '121 pages -> hard block')
assert(exceedsPdfContextHardLimit(150) === true, '150 pages -> hard block')
assert(PDF_CONTEXT_SOFT_WARNING_PAGES === 30 && MAX_PDF_CONTEXT_PAGES === 120, 'constants 30 / 120')
// image count: 600 ok, 601 blocked
assert(exceedsVisionImageCount(600) === false, '600 images -> pass preflight')
assert(exceedsVisionImageCount(601) === true, '601 images -> blocked')
assert(MAX_VISION_IMAGES_PER_REQUEST === 600, 'image count limit = 600')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
