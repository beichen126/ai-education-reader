import 'fake-indexeddb/auto'
import { isVisionModel } from '../src/api/deepseek.ts'
import { initSettings, saveSettings, getSettingsSnapshot, DEFAULT_SETTINGS } from '../src/engine/settings-store.ts'
import { idbClearAll } from '../src/storage/idb.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- isVisionModel respects visionCapability ---
assert(isVisionModel('deepseek-chat', 'auto') === false, 'model without vision + auto -> not vision')
assert(isVisionModel('deepseek-vision', 'auto') === true, 'model with vision + auto -> vision')
assert(isVisionModel('deepseek-chat', 'supports-image') === true, 'explicit supports-image forces vision on')
assert(isVisionModel('custom-vision-model', 'supports-image') === true, 'supports-image enables a name-without-vision model')
assert(isVisionModel('deepseek-vision', 'text-only') === false, 'explicit text-only forbids images')
assert(isVisionModel('deepseek-chat', 'text-only') === false, 'text-only always text')

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