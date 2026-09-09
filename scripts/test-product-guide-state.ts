import 'fake-indexeddb/auto'
import { DB_VERSION, idbClearAll } from '../src/storage/idb.ts'
import { getProductGuideSeenVersion, markProductGuideSeen, PRODUCT_GUIDE_VERSION } from '../src/help/product-guide-state.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

await idbClearAll()
assert(DB_VERSION === 7, 'product guide does not require a DB version change')
assert(await getProductGuideSeenVersion() === undefined, 'fresh storage has no product guide marker')
await markProductGuideSeen()
assert(await getProductGuideSeenVersion() === PRODUCT_GUIDE_VERSION, 'marker round-trips the current guide version')

;(globalThis as { __dshProductGuideMarkerFailure?: boolean }).__dshProductGuideMarkerFailure = true
let rejected = false
try { await markProductGuideSeen() } catch { rejected = true }
assert(rejected, 'injected marker write failure is observable to the caller')
assert(await getProductGuideSeenVersion() === PRODUCT_GUIDE_VERSION, 'marker failure does not corrupt the previous durable value')
delete (globalThis as { __dshProductGuideMarkerFailure?: boolean }).__dshProductGuideMarkerFailure

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
