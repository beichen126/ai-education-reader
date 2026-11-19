import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {initSettings,patchSettings,importApiConfiguration,getSettingsSnapshot,DEFAULT_SETTINGS} from '../src/engine/settings-store.ts'
import {profileConfig} from '../src/engine/api-profiles.ts'
import {exportApiConfiguration} from '../src/engine/api-profile-transfer.ts'
import {buildBackup} from '../src/export/backup-export.ts'
await initSettings()
const config=profileConfig({...DEFAULT_SETTINGS,apiKey:'SECRET-CHAT',speechApiKey:'SECRET-SPEECH'})
await patchSettings({...config,apiProfiles:[{id:'ds',name:'DS',config}],activeApiProfileId:'ds'})
await patchSettings({readUrlEnabled:false,speechVoice:'tide'})
await initSettings()
assert.equal(getSettingsSnapshot().apiProfiles?.[0].config.readUrlEnabled,false)
assert.equal(getSettingsSnapshot().apiProfiles?.[0].config.speechVoice,'tide')
assert.equal(getSettingsSnapshot().apiProfiles?.[0].config.apiKey,'SECRET-CHAT')
const backup=await buildBackup(),json=JSON.stringify(backup)
assert.ok(!json.includes('SECRET-CHAT'));assert.ok(!json.includes('SECRET-SPEECH'))
assert.equal(backup.settings.apiProfiles?.[0].name,'DS')
const saved = getSettingsSnapshot().apiProfiles!
const safeExport = JSON.stringify(exportApiConfiguration(getSettingsSnapshot(), 'Original', false))
assert.doesNotMatch(safeExport, /SECRET-CHAT|apiKey/)
assert.match(JSON.stringify(exportApiConfiguration(getSettingsSnapshot(), 'Original', true)), /SECRET-CHAT/)
const profileFile = exportApiConfiguration(getSettingsSnapshot(), 'Original', true)
profileFile.profiles = [{ ...saved[0], config: { ...saved[0].config, apiBaseUrl:'https://api.example.test/v1', apiKey:'IMPORTED' } }]
profileFile.firecrawl = { keys: ['fc-first', 'fc-second'] }
profileFile.speech = { baseUrl: 'https://speech.example.test/v1', apiKey: 'SPEECH-IMPORT' }
const validText = JSON.stringify({ ...profileFile, localOpenAI: { model:'model-test' } })
const invalidText = JSON.stringify({ ...profileFile, profiles: [...profileFile.profiles, { name:'invalid', config:{ apiBaseUrl:'javascript:alert(1)', model:'example' } }] })
await assert.rejects(importApiConfiguration(invalidText, 'Original'), { row: 2 })
assert.equal(getSettingsSnapshot().apiProfiles?.length, 1, 'invalid files are atomic')
assert.deepEqual(await Promise.all([importApiConfiguration(validText, 'Original'), importApiConfiguration(validText, 'Original')]), [true, false])
const portable = exportApiConfiguration(getSettingsSnapshot(), 'Original', false)
portable.profiles = [{ ...portable.profiles[0], name: 'Portable' }]
assert.doesNotMatch(JSON.stringify(portable), /fc-first|SPEECH-IMPORT|IMPORTED/)
assert.equal(await importApiConfiguration(JSON.stringify({ ...portable, version:1 }), 'Original'), true, 'old JSON format is supported')
await assert.rejects(importApiConfiguration(JSON.stringify({ ...profileFile, firecrawl: { keys: Array.from({ length:9 }, (_, i) => 'fc-other-'+i) } }), 'Original'), { reason:'firecrawl-limit' })
await initSettings()
assert.equal(getSettingsSnapshot().activeApiProfileId, 'ds')
assert.equal(getSettingsSnapshot().apiKey, 'SECRET-CHAT')
assert.equal(getSettingsSnapshot().apiProfiles?.[1].name, 'DS (2)')
assert.equal(getSettingsSnapshot().apiProfiles?.[1].config.apiKey, 'IMPORTED')
assert.equal(getSettingsSnapshot().apiProfiles?.[2].config.apiKey, '')
assert.deepEqual(getSettingsSnapshot().firecrawlKeys?.map(item=>item.key), ['fc-first','fc-second'])
assert.equal(getSettingsSnapshot().speechApiKey, 'SPEECH-IMPORT')
assert.equal(getSettingsSnapshot().speechApiUrl, 'https://speech.example.test/v1')
assert.equal('localOpenAI' in exportApiConfiguration(getSettingsSnapshot(), 'Original', false), false)
console.log('PASS API profile backups, optional key export, atomic import, collision handling and concurrent deduplication')
