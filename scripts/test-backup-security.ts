// Stage 7 backup security + compat: API Key NEVER exported; legacy format still importable.
import 'fake-indexeddb/auto'
import { setSetting, saveConversation } from '../src/storage/storage.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup, BackupError } from '../src/export/backup-import.ts'
import { getSetting } from '../src/storage/storage.ts'
import { closeDb } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

await setSetting('apiKey', 'sk-secret-test-1234567890')
await setSetting('apiBaseUrl', 'https://api.deepseek.com')
await setSetting('model', 'deepseek-v4-flash-vision-exp')
const now = Date.now()
await saveConversation({ id: newStableId(), title: 't', createdAt: now, updatedAt: now, messages: [] })

// 1) export must NOT contain the API key
const backup = await buildBackup()
const json = JSON.stringify(backup)
assert(!json.includes('sk-secret-test-1234567890'), 'export JSON does NOT contain API key')
assert(JSON.stringify(backup.settings).includes('apiBaseUrl'), 'settings still exported (baseUrl)')
assert(!('apiKey' in backup.settings), 'settings object has no apiKey field')

// 2) new format identifier
assert(backup.format === 'ai-education-reader-backup', 'export uses new format identifier')

// 3) legacy format still parses + restores
const legacy = { ...backup, format: 'dsh-eink-backup' }
const parsed = parseAndValidate(JSON.parse(JSON.stringify(legacy)))
assert(parsed.format === 'dsh-eink-backup', 'legacy format accepted on import (no error)')
await restoreBackup(legacy)
await closeDb()
// restore clears apiKey (never resurrects a key from backup)
assert((await getSetting('apiKey')) === undefined || (await getSetting('apiKey')) === '', 'import does NOT restore apiKey')

// 4) a truly unknown format is still rejected
let threw = false
try { parseAndValidate({ ...backup, format: 'unknown-format-xyz' }) } catch (e) { threw = e instanceof BackupError }
assert(threw, 'unknown format still rejected')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
