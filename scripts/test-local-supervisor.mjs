import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { restartDelay, supervise } from '../server/supervise.mjs'
assert.equal(restartDelay(0, null, 0), null)
assert.equal(restartDelay(78, null, 0), null)
assert.equal(restartDelay(null, 'SIGTERM', 0), null)
assert.equal(restartDelay(1, null, 0), 1000)
assert.equal(restartDelay(1, null, 100), 60000)
let child, launches = 0, retry, killed = false
const stop = supervise({ spawnChild() { launches++; child = new EventEmitter(); child.kill = () => { killed = true }; return child }, schedule(fn) { retry = fn; return undefined } })
child.emit('close', 1, null)
assert.equal(launches, 1)
retry()
assert.equal(launches, 2)
stop()
assert.equal(killed, true)
retry = undefined
child.emit('close', 1, null)
assert.equal(retry, undefined)
console.log('PASS: abnormal exit recovery, capped backoff, clean stop and port conflict do not restart')
