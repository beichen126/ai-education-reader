import { generationRegistry } from '../src/engine/generation-registry.ts'
import { tryWithConversationMutationLock } from '../src/prompts/prompt-mode-lock.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

// Exclusive legacy jobs contend with every other job.
for (const contender of ['root:second', 'branch:c:b', 'artifact:a']) {
  generationRegistry.cancel()
  const firstController = new AbortController()
  const first = generationRegistry.acquire('root:first', firstController, 'sending')
  assert(first !== null && generationRegistry.acquire(contender, new AbortController(), 'sending') === null, contender + ' is rejected while root acceptance owns the generation slot')
  first?.release()
}

// The same key is not enough: a different controller/token cannot re-enter, and a
// late release cannot release the next generation that reused the key.
const first = generationRegistry.acquire('root:reused', new AbortController(), 'sending')
assert(first !== null, 'first lease for a reusable root key is acquired')
assert(generationRegistry.begin('root:reused', new AbortController(), 'streaming') === false, 'same key with a different controller is rejected')
first?.release()
const second = generationRegistry.acquire('root:reused', new AbortController(), 'sending')
first?.release()
assert(second !== null && second.isCurrent(), 'stale release cannot clear a newer token for the same key')
second?.release()

const alpha = generationRegistry.acquireChat('root:alpha', 'alpha', new AbortController())
const beta = generationRegistry.acquireChat('branch:beta:child', 'beta', new AbortController())
assert(!!alpha?.isCurrent() && !!beta?.isCurrent(), 'different chats own independent leases')
assert(generationRegistry.acquireChat('branch:alpha:other', 'alpha', new AbortController()) === null, 'same-conversation routes share one lease')
assert(generationRegistry.acquire('artifact:parallel', new AbortController()) === null, 'artifacts retain an exclusive lease')
generationRegistry.stop('root:alpha')
assert(!alpha?.isCurrent() && !!beta?.isCurrent() && generationRegistry.keyForConversation('alpha') === 'root:alpha', 'stopping one chat keeps the other alive and reserves the cancelled slot until settlement')
alpha?.release()
beta?.release()

// Stop is authoritative in both acceptance and streaming states.
for (const status of ['sending', 'streaming'] as const) {
  const controller = new AbortController()
  generationRegistry.acquire('root:stop-' + status, controller, status)
  generationRegistry.cancel()
  assert(controller.signal.aborted && !generationRegistry.isBusy(), 'stop cancels and releases a ' + status + ' lease')
}

// Mode transition and send acceptance use the same atomic per-conversation mutation
// acquisition; a second operation cannot pass a stale Boolean check while the first
// operation is awaiting durable work.
let unlock!: () => void
const holder = tryWithConversationMutationLock('conversation-lock', async () => {
  await new Promise<void>((resolve) => { unlock = resolve })
  return 'held'
})
await Promise.resolve()
const contender = await tryWithConversationMutationLock('conversation-lock', async () => 'unexpected')
assert(!contender.acquired, 'send/mode mutation lock rejects a concurrent acceptance')
unlock()
const held = await holder
assert(held.acquired && held.value === 'held', 'mutation lock releases after durable acceptance completes')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
