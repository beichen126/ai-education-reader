import { generationRegistry, genRootKey, genBranchKey, type GenerationStatus } from '../src/engine/generation-registry.ts'
import { globalGenerationLock } from '../src/engine/chat-generation-service.ts'
let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// 1. begin root -> streaming, busy, key.
const c1 = new AbortController()
assert(generationRegistry.begin(genRootKey('conv1'), c1, 'streaming') === true, 'begin root acquires')
assert(generationRegistry.isBusy() === true, 'registry busy after begin')
assert(generationRegistry.getKey() === genRootKey('conv1'), 'registry key is root:conv1')
assert(generationRegistry.getStatus() === 'streaming', 'root status streaming')

// 2. begin branch while root active -> refused (one-at-a-time).
assert(generationRegistry.begin(genBranchKey('conv1', 'b1'), new AbortController(), 'streaming') === false, 'second generation refused (one at a time)')

// 3. re-entrant same-key begin -> true, status updated.
assert(generationRegistry.begin(genRootKey('conv1'), c1, 'streaming') === true, 're-entrant same key allowed')

// 4. subscribe fires on transitions.
let seen: GenerationStatus[] = []
const unsub = generationRegistry.subscribe(() => seen.push(generationRegistry.getStatus()))
generationRegistry.setStatus('sending')
assert(seen[seen.length - 1] === 'sending', 'subscribe notified on setStatus', )

// 5. end root -> idle.
generationRegistry.end(genRootKey('conv1'))
assert(generationRegistry.isBusy() === false && generationRegistry.getStatus() === 'idle', 'end releases ownership -> idle')

// 6. cancel aborts the controller + releases.
const c2 = new AbortController()
assert(generationRegistry.begin(genBranchKey('c', 'b'), c2, 'streaming') === true, 'begin branch acquires')
const aborted = { flag: false }
c2.signal.addEventListener('abort', () => { aborted.flag = true })
generationRegistry.cancel()
assert(aborted.flag === true, 'cancel() aborts the active controller')
assert(generationRegistry.isBusy() === false, 'cancel() releases ownership -> idle')

// 7. cancelForConversation aborts a branch generation for a conversation.
const c3 = new AbortController()
generationRegistry.begin(genBranchKey('convA', 'bx'), c3, 'streaming')
const aborted3 = { flag: false }
c3.signal.addEventListener('abort', () => { aborted3.flag = true })
generationRegistry.cancelForConversation('convA')
assert(aborted3.flag === true && generationRegistry.isBusy() === false, 'cancelForConversation aborts the branch generation of a conversation')

// 8. globalGenerationLock alias drives the same registry.
const c4 = new AbortController()
assert(globalGenerationLock.tryAcquire('artifact:q1', c4) === true, 'globalGenerationLock alias acquires via registry')
assert(globalGenerationLock.isBusy === true, 'alias isBusy reflects registry')
globalGenerationLock.release('artifact:q1')
assert(globalGenerationLock.isBusy === false, 'alias release clears registry')

// 9. Leases are token/controller aware; a late lease cannot release a newer owner.
const leaseController1 = new AbortController()
const lease1 = generationRegistry.acquire('root:lease', leaseController1, 'sending')
assert(lease1 !== null && lease1.isCurrent(), 'acquire returns a current generation lease')
assert(generationRegistry.acquire('root:lease', new AbortController(), 'sending') === null, 'same key with a different controller is rejected')
assert(generationRegistry.begin('root:lease', new AbortController(), 'streaming') === false, 'same key with a different controller cannot re-enter')
lease1!.release()
const leaseController2 = new AbortController()
const lease2 = generationRegistry.acquire('root:lease', leaseController2, 'sending')
lease1!.release()
assert(lease2 !== null && generationRegistry.getKey() === 'root:lease' && lease2.isCurrent(), 'stale lease release cannot release the newer owner')
assert(lease1!.setStreaming() === false, 'stale lease cannot change the newer owner status')
lease2!.release()
assert(!generationRegistry.isBusy(), 'current lease releases cleanly')

unsub()
console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
