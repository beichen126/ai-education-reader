// Stage 6 limit predicates: page soft/hard limits, group byte budget, draft guard, image count.
import { needsPdfContextSoftConfirm, exceedsPdfContextHardLimit, exceedsPdfGroupByteBudget, MAX_PDF_GROUP_RAW_BYTES, PDF_CONTEXT_SOFT_WARNING_PAGES, MAX_PDF_CONTEXT_PAGES } from '../src/pdf/pdf-types.ts'
import { wouldExceedInlineBudget, isInlineImageOverBudget, MAX_INLINE_IMAGE_RAW_BYTES } from '../src/engine/attachment-service.ts'
import { exceedsVisionImageCount, MAX_VISION_IMAGES_PER_REQUEST } from '../src/api/deepseek.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const MB = 1024 * 1024

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
// group byte budget: 23MiB ok, 24MiB exactly ok, 24MiB+1 stop
assert(exceedsPdfGroupByteBudget(23 * MB) === false, '23 MiB group -> allow')
assert(exceedsPdfGroupByteBudget(24 * MB) === false, '24 MiB exactly -> allow')
assert(exceedsPdfGroupByteBudget(24 * MB + 1) === true, '24 MiB + 1 -> stop generation')
assert(MAX_PDF_GROUP_RAW_BYTES === 24 * MB, 'group budget = 24 MiB')
// draft early guard: 8+21=29MiB allow, 10+21=31MiB reject
assert(wouldExceedInlineBudget(8 * MB, 21 * MB) === false, '8 MiB existing + 21 MiB new -> allow')
assert(wouldExceedInlineBudget(10 * MB, 21 * MB) === true, '10 MiB existing + 21 MiB new -> reject add')
// final request byte guard intact
assert(isInlineImageOverBudget(30 * MB) === false, 'final guard: 30 MiB exactly -> allow')
assert(isInlineImageOverBudget(30 * MB + 1) === true, 'final guard: 30 MiB + 1 -> block')
assert(MAX_INLINE_IMAGE_RAW_BYTES === 30 * MB, 'final request budget = 30 MiB')
// image count: 600 ok, 601 blocked
assert(exceedsVisionImageCount(600) === false, '600 images -> pass preflight')
assert(exceedsVisionImageCount(601) === true, '601 images -> blocked')
assert(MAX_VISION_IMAGES_PER_REQUEST === 600, 'image count limit = 600')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
