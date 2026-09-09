import { DEFAULT_PDF_NAVIGATION_MODE, isPdfNavigationMode, normalizePdfNavigationMode } from '../src/engine/pdf-navigation-settings.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

assert(DEFAULT_PDF_NAVIGATION_MODE === 'paged', 'default navigation mode remains paged')
assert(normalizePdfNavigationMode(undefined) === 'paged', 'missing legacy setting falls back to paged')
assert(normalizePdfNavigationMode('paged') === 'paged', 'paged persists as paged')
assert(normalizePdfNavigationMode('continuous') === 'continuous', 'continuous is accepted')
assert(normalizePdfNavigationMode('scrollEnabled') === 'paged', 'legacy boolean-like value cannot enable continuous mode')
assert(normalizePdfNavigationMode(null) === 'paged', 'null falls back to paged')
assert(isPdfNavigationMode('paged') && isPdfNavigationMode('continuous'), 'only the two declared modes are valid')
assert(!isPdfNavigationMode('invalid'), 'unknown mode is rejected')

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
