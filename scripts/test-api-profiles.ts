import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {initSettings,patchSettings,getSettingsSnapshot,DEFAULT_SETTINGS} from '../src/engine/settings-store.ts'
import {profileConfig} from '../src/engine/api-profiles.ts'
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
console.log('PASS profile settings persist atomically and backups omit all profile keys')
