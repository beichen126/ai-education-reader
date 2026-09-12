// v2.2.0 Stage 1 domain gate: settings mutations are serial, last-intent-wins, and a failed
// commit neither publishes a new state nor poisons later writes.
import 'fake-indexeddb/auto'
import { getSetting } from '../src/storage/storage.ts'
import { closeDb } from '../src/storage/idb.ts'
import {
  initSettings, patchSettings, saveSettings, setAppearance, setPdfNavigationMode,
  getSettingsSnapshot, getSettingsMutationSnapshot, DEFAULT_SETTINGS,
} from '../src/engine/settings-store.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) }
}
const durable = async (key: string) => (await getSetting(key)) as string | undefined

// Failure injection at the storage boundary: the next settings write throws before any
// request is issued, which is exactly what an aborted IndexedDB transaction looks like to
// saveSettingsAtomic (its promise rejects and nothing commits).
const realPut = IDBObjectStore.prototype.put
let failNextWrites = 0
IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: unknown[]) {
  if (failNextWrites > 0) { failNextWrites--; throw new Error('injected IndexedDB failure') }
  return realPut.apply(this, args as never)
} as typeof IDBObjectStore.prototype.put

await initSettings()
assert(getSettingsSnapshot().pdfNavigationMode === 'paged', 'fresh install starts paged')

// ---- 1. a single-field patch persists and publishes ----
await patchSettings({ pdfNavigationMode: 'continuous' })
assert(getSettingsSnapshot().pdfNavigationMode === 'continuous', 'patch publishes the committed navigation mode')
assert(await durable('pdfNavigationMode') === 'continuous', 'patch commits the navigation mode')

// ---- 2. patches merge onto the latest committed state ----
await patchSettings({ apiKey: 'sk-merge' })
assert(getSettingsSnapshot().pdfNavigationMode === 'continuous', 'an API patch does not clobber the committed PDF mode')
assert(await durable('pdfNavigationMode') === 'continuous', 'durable navigation mode survives an API patch')
assert(await durable('apiKey') === 'sk-merge', 'API patch commits its own field')

// ---- 3. the committed store is published only AFTER the commit ----
const inFlight = patchSettings({ model: 'deepseek-model-b' })
assert(getSettingsSnapshot().model === DEFAULT_SETTINGS.model, 'an in-flight patch has not been published yet')
await inFlight
assert(getSettingsSnapshot().model === 'deepseek-model-b', 'the patch is published after commit')

// ---- 4. rapid A -> B keeps the last intent durable ----
const first = setPdfNavigationMode('paged')
const second = setPdfNavigationMode('continuous')
await Promise.all([first, second])
assert(getSettingsSnapshot().pdfNavigationMode === 'continuous', 'rapid 单页->连续 publishes 连续')
assert(await durable('pdfNavigationMode') === 'continuous', 'rapid 单页->连续 leaves 连续 durable')

// ---- 5. many queued patches keep their order ----
await Promise.all([
  patchSettings({ model: 'm-1' }), patchSettings({ model: 'm-2' }), patchSettings({ model: 'm-3' }),
  patchSettings({ model: 'm-4' }), patchSettings({ model: 'm-5' }),
])
assert(getSettingsSnapshot().model === 'm-5', 'queued model patches publish the last value')
assert(await durable('model') === 'm-5', 'queued model patches commit the last value')

// ---- 6. a failed commit rolls back and does not poison the queue ----
failNextWrites = 1
let rejected = false
try { await patchSettings({ pdfNavigationMode: 'paged' }) } catch { rejected = true }
assert(rejected, 'a failed commit rejects the caller')
assert(getSettingsSnapshot().pdfNavigationMode === 'continuous', 'a failed commit leaves the committed value published')
assert(await durable('pdfNavigationMode') === 'continuous', 'a failed commit writes nothing durable')
assert(getSettingsMutationSnapshot().status === 'error', 'the failure is observable through the mutation state')
failNextWrites = 0
await patchSettings({ apiKey: 'sk-after-failure' })
assert(await durable('apiKey') === 'sk-after-failure', 'a later mutation still commits after a failure')
assert(getSettingsMutationSnapshot().status === 'idle', 'a successful mutation clears the failure state')

// ---- 7. appearance and PDF writes never lose each other ----
await Promise.all([setAppearance('dark'), setPdfNavigationMode('paged')])
assert(getSettingsSnapshot().appearance === 'dark' && await durable('appearance') === 'dark', 'concurrent appearance write is durable')
assert(getSettingsSnapshot().pdfNavigationMode === 'paged' && await durable('pdfNavigationMode') === 'paged', 'concurrent PDF write is durable')

// ---- 8. invalid values are normalized, never stored raw ----
await patchSettings({ appearance: 'neon' as never, visionCapability: 'telepathy' as never, pdfNavigationMode: 'scrollEnabled' as never })
assert(getSettingsSnapshot().appearance === 'system', 'unknown appearance falls back to system')
assert(getSettingsSnapshot().visionCapability === 'auto', 'unknown vision capability falls back to auto')
assert(getSettingsSnapshot().pdfNavigationMode === 'paged', 'legacy navigation value falls back to paged')
assert(await durable('appearance') === 'system', 'the normalized appearance is what gets committed')

// ---- 9. the whole-object compatibility entry point still merges onto committed state ----
await saveSettings({ ...getSettingsSnapshot(), apiKey: 'sk-whole' })
assert(await durable('apiKey') === 'sk-whole', 'saveSettings commits the whole object')
assert(await durable('pdfNavigationMode') === 'paged', 'saveSettings keeps the navigation mode it was given')

// ---- 10. reopen keeps everything ----
await closeDb()
await initSettings()
assert(getSettingsSnapshot().apiKey === 'sk-whole', 'reopen reads the committed API key')
assert(getSettingsSnapshot().appearance === 'system', 'reopen reads the committed appearance')
assert(getSettingsSnapshot().pdfNavigationMode === 'paged', 'reopen reads the committed navigation mode')

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
