import 'fake-indexeddb/auto'
import { initSettings, saveSettings, getSettingsSnapshot, DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { idbClearAll } from '../src/storage/idb.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- settings atomic: visionCapability persists and round-trips ---
await idbClearAll()
await initSettings()
assert(getSettingsSnapshot().visionCapability === 'auto', 'default visionCapability is auto')
assert(getSettingsSnapshot().appearance === DEFAULT_SETTINGS.appearance, 'default appearance preserved')
await saveSettings({ ...getSettingsSnapshot(), apiKey: 'k', model: 'custom', visionCapability: 'supports-image', appearance: 'dark' })
await initSettings()
const s2 = getSettingsSnapshot()
assert(s2.visionCapability === 'supports-image', 'visionCapability persisted + reloaded')
assert(s2.appearance === 'dark', 'appearance persisted in same atomic settings commit')
assert(s2.apiKey === 'k' && s2.model === 'custom', 'apiKey + model persisted atomically')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)