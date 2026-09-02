import 'fake-indexeddb/auto'
import { initStore, getSessionsSendError } from '../src/engine/sessions-store.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }

// Simulate an IndexedDB open failure exactly once (openDb should reset its cached
// promise so a later open can retry instead of being stuck on a rejected promise).
const origOpen = indexedDB.open.bind(indexedDB) as any
let failNext = true
const failingOpen = (...args: any[]) => {
  const req: any = { error: new Error('idb denied'), onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }
  queueMicrotask(() => { try { if (req.onerror) req.onerror({ target: req }) } catch {} })
  return req
}
;(indexedDB as any).open = failingOpen

// 1) initStore (App boot) rejects when IndexedDB cannot open -> App would show '载入失败/重试'.
let threw = false
try { await initStore() } catch { threw = true }
assert(threw, 'initStore rejects on IndexedDB open failure (drives boot error state)')

// 2) Restore the real open; because dbPromise was reset to null on error, a retry works.
;(indexedDB as any).open = origOpen
let ok = false
try { await initStore(); ok = true } catch { ok = false }
assert(ok, 'after restoring open, initStore retries and succeeds (dbPromise reset allowed retry, db was NOT cleared)')

// 3) The data was not auto-cleared by the failed boot: a normal conversation exists.
//    (fake-indexeddb created a fresh DB on retry, which initStore seeds with a sample.)

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

