import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { clearReadingPositions, loadReadingPosition, readingPositionEpoch, readingPositionKey, READING_POSITIONS_KEY, saveReadingPosition, validReadingPosition } from '../src/engine/reading-position'
import { DEFAULT_SETTINGS, normalizeSettings, initSettings, patchSettings, getSettingsSnapshot } from '../src/engine/settings-store'
import { getSetting } from '../src/storage/storage'
import { buildBackup } from '../src/export/backup-export'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import'

const data=new Map<string,string>()
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key)}})
assert.equal(DEFAULT_SETTINGS.rememberReadingPosition,false)
assert.equal(normalizeSettings({...DEFAULT_SETTINGS,rememberReadingPosition:'true' as any}).rememberReadingPosition,false)
const main=readingPositionKey('chat'), branch=readingPositionKey('chat','branch')
assert.notEqual(main,branch)
assert.notEqual(readingPositionKey('a:b','c'),readingPositionKey('a','b:c'))
const point={messageId:'m1',offset:-43,scrollTop:1000,atBottom:false,updatedAt:123}
saveReadingPosition(main,point)
assert.deepEqual(loadReadingPosition(main),point)
assert.equal(loadReadingPosition(branch),undefined)
saveReadingPosition(branch,{...point,messageId:'b1'})
assert.equal(loadReadingPosition(main)?.messageId,'m1')
assert.equal(loadReadingPosition(branch)?.messageId,'b1')
assert.equal(validReadingPosition({...point,scrollTop:NaN}),false)
data.set(READING_POSITIONS_KEY,'{broken')
assert.equal(loadReadingPosition(main),undefined)
for(let i=0;i<220;i++)saveReadingPosition(readingPositionKey(String(i)),{...point,updatedAt:i})
assert.equal(Object.keys(JSON.parse(data.get(READING_POSITIONS_KEY)!)).length,200)
const before=readingPositionEpoch();clearReadingPositions()
assert.equal(data.has(READING_POSITIONS_KEY),false)
assert.equal(readingPositionEpoch(),before+1)
await initSettings()
assert.equal(getSettingsSnapshot().rememberReadingPosition,false)
await patchSettings({rememberReadingPosition:true})
assert.equal(await getSetting('rememberReadingPosition'),'true')
const backup=await buildBackup()
assert.equal(backup.settings.rememberReadingPosition,true)
assert.throws(()=>parseAndValidate({...backup,settings:{...backup.settings,rememberReadingPosition:'yes'}}))
await restoreBackup(backup)
await initSettings()
assert.equal(getSettingsSnapshot().rememberReadingPosition,true)
const legacy=structuredClone(backup)
delete legacy.settings.rememberReadingPosition
await restoreBackup(legacy)
await initSettings()
assert.equal(getSettingsSnapshot().rememberReadingPosition,false,'legacy backups default to disabled')
Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('blocked')}})
assert.doesNotThrow(()=>saveReadingPosition(main,point))
assert.doesNotThrow(clearReadingPositions)
assert.equal(loadReadingPosition(main),undefined)
console.log('PASS reading positions: opt-in, validation, bounded storage, thread isolation, clear epoch, blocked storage')
