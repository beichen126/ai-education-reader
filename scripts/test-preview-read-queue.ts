import assert from 'node:assert/strict'
import { PreviewReadQueue } from '../src/engine/preview-read-queue.ts'
const queue = new PreviewReadQueue(2)
let active = 0, peak = 0
const results = await Promise.all(Array.from({ length: 12 }, (_, index) => queue.run(async () => {
  active++; peak = Math.max(peak, active)
  await new Promise(resolve => setTimeout(resolve, 3))
  active--; return index
})))
assert.equal(peak, 2)
assert.deepEqual(results, Array.from({ length: 12 }, (_, index) => index))
await assert.rejects(queue.run(async () => { throw new Error('failed read') }))
assert.equal(await queue.run(async () => 'recovered'), 'recovered')
console.log('PASS preview reads: two parallel reads, ordered results, failure releases slot')
