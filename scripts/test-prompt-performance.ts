import type { Conversation, Message } from '../src/engine/types.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'
import type { PromptTransition } from '../src/prompts/prompt-types.ts'
import { buildEffectivePromptPath } from '../src/prompts/effective-prompt-path.ts'

let pass = 0
let fail = 0
const assert = (condition: boolean, message: string): void => {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
const message = (id: string): Message => ({ id, role: 'user', content: id, images: [], createdAt: 1, updatedAt: 1 })
const transition = (id: string, afterMessageId: string | null): PromptTransition => ({
  id, afterMessageId, createdAt: 1,
  snapshot: { kind: 'conversation-mode', profileId: id, name: id, content: 'mode-' + id, revision: 1, source: 'custom', capturedAt: 1 },
})

function fixture(messageCount: number, transitionCount: number, depth: number, unrelatedBranches = 0): { conversation: Conversation; branches: ConversationBranch[]; activeBranchId: string } {
  const messages = Array.from({ length: messageCount }, (_, index) => message('m-' + index))
  const transitions = Array.from({ length: transitionCount }, (_, index) => transition('t-' + index, 'm-' + Math.min(messageCount - 1, index * Math.max(1, Math.floor(messageCount / transitionCount)))))
  const conversation: Conversation = { id: 'performance', title: 'performance', createdAt: 1, updatedAt: 1, messages, promptTransitions: transitions }
  const branches: ConversationBranch[] = []
  let parentBranchId: string | undefined
  let forkMessageId = 'm-' + (messageCount - 1)
  for (let index = 0; index < depth; index++) {
    const id = 'active-' + index
    const localId = id + '-message'
    branches.push({ id, conversationId: conversation.id, parentBranchId, forkMessageId, title: id, createdAt: 1, updatedAt: 1, messages: [message(localId)], promptTransitions: [transition(id + '-transition', localId)] })
    parentBranchId = id
    forkMessageId = localId
  }
  for (let index = 0; index < unrelatedBranches; index++) {
    branches.push({ id: 'unrelated-' + index, conversationId: conversation.id, forkMessageId: 'm-0', title: 'unrelated', createdAt: 1, updatedAt: 1, messages: [message('unrelated-' + index + '-message')] })
  }
  return { conversation, branches, activeBranchId: 'active-' + (depth - 1) }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function measure(fixtureInput: ReturnType<typeof fixture>, repetitions = 5): number {
  // Warm the branch-index cache so this measures repeated materialization, not
  // one-time catalogue/index construction.
  buildEffectivePromptPath(fixtureInput.conversation, fixtureInput.branches, fixtureInput.activeBranchId)
  const samples: number[] = []
  for (let index = 0; index < repetitions; index++) {
    const started = performance.now()
    const result = buildEffectivePromptPath(fixtureInput.conversation, fixtureInput.branches, fixtureInput.activeBranchId)
    if (!result.resolved) throw new Error('performance fixture unexpectedly unresolved')
    samples.push(performance.now() - started)
  }
  return median(samples)
}

function structuralAccesses(unrelatedBranches: number): { cold: number; hot: number; coldIterators: number; hotIterators: number } {
  const fixtureInput = fixture(20, 2, 3, unrelatedBranches)
  let numericAccesses = 0
  let iteratorReads = 0
  const observed = new Proxy(fixtureInput.branches, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) iteratorReads++
      if (typeof property === 'string' && /^\d+$/.test(property)) numericAccesses++
      return Reflect.get(target, property, receiver)
    },
  })
  buildEffectivePromptPath(fixtureInput.conversation, observed, fixtureInput.activeBranchId)
  const cold = numericAccesses
  const coldIterators = iteratorReads
  numericAccesses = 0
  iteratorReads = 0
  buildEffectivePromptPath(fixtureInput.conversation, observed, fixtureInput.activeBranchId)
  return { cold, hot: numericAccesses, coldIterators, hotIterators: iteratorReads }
}

const structural5k = structuralAccesses(5000)
const structural20k = structuralAccesses(20000)
console.log('STRUCTURAL cold5k=' + structural5k.cold + ' hot5k=' + structural5k.hot + ' cold5kIterators=' + structural5k.coldIterators + ' hot5kIterators=' + structural5k.hotIterators + ' cold20k=' + structural20k.cold + ' hot20k=' + structural20k.hot + ' cold20kIterators=' + structural20k.coldIterators + ' hot20kIterators=' + structural20k.hotIterators)
assert(structural5k.cold >= 5000 && structural20k.cold >= 20000, 'cold index construction observes the supplied branch catalogue')
assert(structural5k.hot === 0 && structural20k.hot === 0 && structural5k.hotIterators === 0 && structural20k.hotIterators === 0, 'warm materialization does not iterate unrelated branch rows')

const mutationFixture = fixture(20, 2, 3, 100)
const activeMutationBranch = mutationFixture.branches.find((branch) => branch.id === mutationFixture.activeBranchId)
if (!activeMutationBranch) throw new Error('active performance fixture branch is missing')
const beforeMutation = buildEffectivePromptPath(mutationFixture.conversation, mutationFixture.branches, mutationFixture.activeBranchId)
activeMutationBranch.promptTransitions = (activeMutationBranch.promptTransitions ?? []).map((item) => ({ ...item, snapshot: { ...item.snapshot, name: 'updated-current-path' } }))
const afterMutation = buildEffectivePromptPath(mutationFixture.conversation, mutationFixture.branches, mutationFixture.activeBranchId)
assert(afterMutation.transitions.some((item) => item.snapshot.name === 'updated-current-path') && afterMutation.transitions.length === beforeMutation.transitions.length, 'current-path transition changes invalidate the materialized result')
const unrelatedMutationBranch = mutationFixture.branches.find((branch) => branch.id === 'unrelated-0')
if (!unrelatedMutationBranch) throw new Error('unrelated performance fixture branch is missing')
const beforeUnrelatedMutation = afterMutation.transitions.map((item) => item.id).join('|')
unrelatedMutationBranch.promptTransitions = [transition('unrelated-mutation', 'm-0')]
const afterUnrelatedMutation = buildEffectivePromptPath(mutationFixture.conversation, mutationFixture.branches, mutationFixture.activeBranchId)
assert(afterUnrelatedMutation.transitions.map((item) => item.id).join('|') === beforeUnrelatedMutation, 'unrelated branch mutation does not change the active timeline')

const baseline = fixture(1000, 100, 20)
const large = fixture(4000, 400, 80)
const noisy = fixture(1000, 100, 20, 5000)
const baseResult = buildEffectivePromptPath(baseline.conversation, baseline.branches, baseline.activeBranchId)
const largeResult = buildEffectivePromptPath(large.conversation, large.branches, large.activeBranchId)
assert(baseResult.resolved && baseResult.messageIds.length === 1020, '1,000 messages + 20-level branch path materializes correctly')
assert(baseResult.resolved && baseResult.transitions.length === 120, '100 root transitions + 20 branch transitions remain available')
assert(largeResult.resolved && largeResult.messageIds.length === 4080, '4,000 messages + 80-level branch path materializes correctly')

const baselineMs = measure(baseline)
const largeMs = measure(large)
const baselineNoisyMs = measure(baseline)
const noisyMs = measure(noisy)
console.log('PERFORMANCE baselineMedianMs=' + baselineMs.toFixed(3) + ' largeMedianMs=' + largeMs.toFixed(3) + ' noisyMedianMs=' + noisyMs.toFixed(3) + ' baselineNoisyMedianMs=' + baselineNoisyMs.toFixed(3))
assert(largeMs <= baselineMs * 10 + 2, 'large timeline stays within a relative linear-growth budget')
assert(noisyMs <= baselineNoisyMs * 4 + 2, 'repeated materialization is insensitive to unrelated branch rows')
assert(noisyMs >= 0 && baselineMs >= 0, 'benchmark records relative timings without an absolute-second gate')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
