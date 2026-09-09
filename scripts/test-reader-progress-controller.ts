import { ReaderProgressController } from '../src/documents/reader-progress-controller.ts'

type WriteCall = { id: string; page: number }
const calls: WriteCall[] = []
const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
let mode: 'immediate' | 'deferred' | 'fail-once' | 'deleted' = 'immediate'
let failOnce = true

const writer = async (id: string, page: number) => {
  calls.push({ id, page })
  if (mode === 'deferred') await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
  if (mode === 'fail-once' && failOnce) { failOnce = false; throw new Error('temporary write failure') }
  if (mode === 'deleted') { const error = new Error('document missing'); error.name = 'DocumentNotFoundError'; throw error }
}

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}
async function tick() { await Promise.resolve(); await Promise.resolve() }
async function ticks(count: number) { for (let i = 0; i < count; i++) await tick() }
function reset() { calls.length = 0; pending.length = 0; mode = 'immediate'; failOnce = true }

reset()
const controller = new ReaderProgressController(writer, { debounceMs: 100000, retryBaseMs: 100000 })
controller.bind('doc-a', 1)
await controller.flush('bind')
assert(calls.length === 0, 'bind does not write the durable page')

controller.observePage(2, 'navigation')
controller.observePage(3, 'navigation')
await controller.flush('manual')
assert(calls.length === 1 && calls[0].page === 3, 'rapid 1→2→3 flush writes only the latest page')
assert(controller.snapshot().dirty === false && controller.snapshot().confirmedPage === 3, 'successful latest write clears dirty and confirms page 3')

reset()
const stale = new ReaderProgressController(writer, { debounceMs: 100000, retryBaseMs: 100000 })
stale.bind('doc-stale', 1)
stale.observePage(2, 'navigation')
mode = 'deferred'
const firstFlush = stale.flush('manual')
await tick()
stale.observePage(3, 'navigation')
const secondFlush = stale.flush('manual')
assert(calls.length === 1 && calls[0].page === 2, 'second flush waits for the first in-flight write')
pending.shift()?.resolve()
await ticks(10)
assert(calls.length === 2 && calls[1].page === 3, 'newer page is serialized after the older write')
pending.shift()?.resolve()
await ticks(10)
await Promise.all([firstFlush, secondFlush])
assert(stale.snapshot().confirmedPage === 3 && !stale.snapshot().dirty, 'stale write cannot win over the newer page')

reset()
const lifecycle = new ReaderProgressController(writer, { debounceMs: 100000, retryBaseMs: 100000 })
lifecycle.bind('doc-life', 1)
lifecycle.observePage(4, 'navigation')
const lifeFlush = lifecycle.flush('hidden')
const duplicateFlush = lifecycle.flush('pagehide')
const release = lifecycle.release('close')
await Promise.all([lifeFlush, duplicateFlush, release])
assert(calls.length === 1 && calls[0].page === 4, 'debounce, hidden, pagehide and close share one flush without duplicate writes')

reset()
mode = 'fail-once'
const retryable = new ReaderProgressController(writer, { debounceMs: 100000, retryBaseMs: 100000 })
retryable.bind('doc-retry', 1)
retryable.observePage(5, 'navigation')
const failed = await retryable.flush('manual')
assert(!failed.ok && retryable.snapshot().dirty && !!retryable.snapshot().lastError, 'write failure keeps dirty state and exposes an error')
const retried = await retryable.retry()
assert(retried.ok && !retryable.snapshot().dirty && calls.length === 2, 'explicit retry eventually confirms the page')

reset()
const owners = new ReaderProgressController(writer, { debounceMs: 100000, retryBaseMs: 100000 })
const bindingA = owners.bind('doc-a', 1)
owners.observePage(20, 'navigation')
const releaseA = owners.release('switch')
const bindingB = owners.bind('doc-b', 1)
owners.observePage(30, 'navigation')
await owners.flush('manual')
await releaseA
assert(calls.map(call => call.id + ':' + call.page).join(',') === 'doc-a:20,doc-b:30', 'switch flush preserves document ownership and write order')
const ignoredOldCleanup = await owners.release('switch', bindingA)
assert(ignoredOldCleanup.ok && owners.snapshot().ownerDocumentId === 'doc-b', 'stale cleanup token cannot release the newer document session')
await owners.release('switch', bindingB)

reset()
mode = 'deleted'
const deleted = new ReaderProgressController(writer, { debounceMs: 100000, retryBaseMs: 100000 })
deleted.bind('deleted-doc', 1)
deleted.observePage(6, 'navigation')
const deletedResult = await deleted.flush('manual')
await deleted.retry()
await deleted.release('close')
assert(!deletedResult.ok && deletedResult.terminal === true && calls.length === 1, 'deleted document stops queued and retry writes without resurrection')

reset()
mode = 'fail-once'
const pendingRetry = new ReaderProgressController(writer, { debounceMs: 100000, retryBaseMs: 100000 })
pendingRetry.bind('doc-pending', 1)
pendingRetry.observePage(7, 'navigation')
const releaseFailure = await pendingRetry.release('close')
assert(!releaseFailure.ok && calls.length === 1, 'close flush failure is reported instead of swallowed')
mode = 'immediate'
pendingRetry.bind('doc-pending', 1)
await pendingRetry.flush('rebind')
assert(calls.length === 2 && calls[1].page === 7, 'failed close keeps an in-memory pending page for the next bind')

console.log('\nSUMMARY ' + pass + '/' + (pass + fail) + ' passed')
process.exit(fail === 0 ? 0 : 1)
