import test from 'node:test'
import assert from 'node:assert/strict'
import { createPairingStore } from '../server/pairing-store.mjs'
const origin = 'https://beichen126.github.io'
test('remembered pairing survives store restart, renews on use, expires idle and revokes permanently', async () => {
  let state = { hostId: 'urn:uuid:test', profiles: [] }, time = 1000000
  const vault = { load: async () => structuredClone(state), save: async value => { state = structuredClone(value) } }
  const store = await createPairingStore(vault, () => time)
  const token = await store.issue(origin)
  assert.doesNotMatch(JSON.stringify(state), new RegExp(token))
  assert.equal(await store.validate(token, origin), true)
  assert.equal(await store.validate(token, 'https://evil.test'), false)
  assert.equal(await store.validate('bad', origin), false)
  let next = await createPairingStore(vault, () => time)
  assert.equal(await next.validate(token, origin), true)
  time += 25 * 86400000
  assert.equal(await next.validate(token, origin), true)
  time += 25 * 86400000
  assert.equal(await next.validate(token, origin), true)
  await next.revoke(token)
  next = await createPairingStore(vault, () => time)
  assert.equal(await next.validate(token, origin), false)
  const idle = await next.issue(origin)
  time += 31 * 86400000
  assert.equal(await next.validate(idle, origin), false)
})
