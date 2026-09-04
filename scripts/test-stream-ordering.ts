import 'fake-indexeddb/auto'
import { enqueueWrite, persistConversation } from '../src/engine/sessions-store.ts'
import { saveConversation, getConversation } from '../src/storage/storage.ts'
import { newStableId } from '../src/engine/types.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- A: writes are STRICTLY ordered — a stale partial can never land after a newer revision ---
{
  const id = newStableId()
  const order: string[] = []
  let releaseOld: (() => void) | null = null
  // Enqueue an OLD (stale partial) write that will be held open (delayed).
  const oldWrite = enqueueWrite(id, async () => {
    order.push('old-start')
    await new Promise<void>((r) => { releaseOld = r })
    order.push('old-end')
    await saveConversation({ id, title: 'c', createdAt: 1, updatedAt: 1, messages: [{ id: 'm', role: 'assistant', content: 'STALE', createdAt: 2, updatedAt: 2 }] })
  })
  // Enqueue a NEWER (final) write — it MUST NOT start until the old one finishes.
  const newWrite = enqueueWrite(id, async () => {
    order.push('new-start')
    await saveConversation({ id, title: 'c', createdAt: 1, updatedAt: 1, messages: [{ id: 'm', role: 'assistant', content: 'FINAL', createdAt: 3, updatedAt: 3 }] })
    order.push('new-end')
  })
  // Give the engine a tick: new must NOT have started while old is held.
  await new Promise(r => setTimeout(r, 20))
  assert(!order.includes('new-start'), 'A: newer write does NOT start before old completes (ordered)')
  assert(order.includes('old-start'), 'A: old write started')
  // Release the old write; both settle. New must run after old-end.
  if (releaseOld) releaseOld()
  await oldWrite; await newWrite
  const oldEnd = order.indexOf('old-end'); const newStart = order.indexOf('new-start')
  assert(oldEnd >= 0 && newStart > oldEnd, 'A: new write starts AFTER old write completes (got order ' + order.join(',') + ')')
  const conv = await getConversation(id)
  assert(conv && conv.messages[0].content === 'FINAL', 'A: final persisted content is the NEWEST (got ' + (conv && conv.messages[0].content) + ')')
}


// --- B: a queued/checkpoint write for a DELETED conversation never recreates the row ---
{
  const id2 = newStableId()
  // The conversation is NOT in store state (simulating a deletion; the stream's later
  // persistConversation guard must skip it so a late checkpoint cannot resurrect it).
  await persistConversation({ id: id2, title: 'vanish', createdAt: 1, updatedAt: 1, messages: [{ id: 'm', role: 'assistant', content: 'LATE', createdAt: 2, updatedAt: 2 }] })
  const conv = await getConversation(id2)
  assert(conv === undefined, 'B: a checkpoint write for a deleted conversation does NOT recreate the row')
}

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
