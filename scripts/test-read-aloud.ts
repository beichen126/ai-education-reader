import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { speechChunks, preferredVoice, readAloud, speechSnapshot, stopReadAloud, pauseReadAloud, resumeReadAloud } from '../src/speech/read-aloud.ts'
import { patchSettings, initSettings, getSettingsSnapshot, normalizeSpeechRate, normalizeSpeechRepeat } from '../src/engine/settings-store.ts'
import { markContext } from '../src/study-cards/mark-context.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { idbClearAll } from '../src/storage/idb.ts'

await idbClearAll(); await initSettings()
assert.equal(getSettingsSnapshot().speechRepeatCount,3)
assert.deepEqual(speechChunks('你好世界。 Hello world!').map(chunk=>[chunk.lang,chunk.rate]),[['zh-CN',1],['en-US',0.9]])
assert.ok(speechChunks('x'.repeat(1000)).every(chunk=>chunk.text.length<=220))
assert.equal(normalizeSpeechRate(NaN,1),1); assert.equal(normalizeSpeechRepeat(0),3)
const voices = [{name:'Microsoft Natural Online',lang:'en-US',default:false},{name:'Local English',lang:'en-US',default:true},{name:'Microsoft Xiaoxiao Online',lang:'zh-CN'}] as SpeechSynthesisVoice[]
assert.equal(preferredVoice(voices,'en-US')?.name,'Microsoft Natural Online')
assert.equal(preferredVoice(voices,'zh-CN')?.name,'Microsoft Xiaoxiao Online')
assert.equal(preferredVoice([{name:'Microsoft Cantonese Online',lang:'zh-HK'},{name:'Mandarin local',lang:'zh-CN'}] as SpeechSynthesisVoice[],'zh-CN')?.name,'Mandarin local','Mandarin must not silently become Cantonese just to use an online voice')
const spoken: any[] = []
let cancels=0,pauses=0,resumes=0
Object.assign(globalThis,{window:{speechSynthesis:{cancel(){cancels++},pause(){pauses++},resume(){resumes++},getVoices(){return voices},speak(utterance:any){spoken.push(utterance)}}},SpeechSynthesisUtterance:class{constructor(public text:string){}}})
readAloud('你好。 Hello.','owner')
assert.equal(spoken.length,1)
pauseReadAloud();assert.equal(speechSnapshot().status,'paused');resumeReadAloud();assert.equal(speechSnapshot().status,'speaking')
for(let i=0;i<6;i++) spoken[i].onend()
assert.deepEqual(spoken.map(item=>item.lang),['zh-CN','en-US','zh-CN','en-US','zh-CN','en-US'],'whole bilingual selection repeats exactly three times')
assert.equal(speechSnapshot().status,'idle');assert.equal(pauses,1);assert.equal(resumes,1)
readAloud('Hello.','old'); const stale=spoken[6]
readAloud('你好。','new');const count=spoken.length
stale.onend();stale.onerror();assert.equal(spoken.length,count);assert.equal(speechSnapshot().owner,'new')
stopReadAloud('old');assert.equal(speechSnapshot().owner,'new')
stopReadAloud('new');assert.equal(speechSnapshot().status,'idle');assert.ok(cancels>=3)
await patchSettings({chineseSpeechRate:1.2,englishSpeechRate:0.8,speechRepeatCount:5})
await initSettings()
assert.deepEqual(speechChunks('你好。 Hello.').map(chunk=>chunk.rate),[1.2,0.8])
const backup=await buildBackup()
assert.equal(backup.settings.speechRepeatCount,5)
await restoreBackup(parseAndValidate(backup));await initSettings()
assert.equal(getSettingsSnapshot().englishSpeechRate,0.8)
const malformed=structuredClone(backup);malformed.settings.speechRepeatCount=11
assert.throws(()=>parseAndValidate(malformed),/speechRepeatCount/)
const text='Zero. One. Two. Target. Four. Five. Six.'
const start=text.indexOf('Target')
assert.deepEqual(markContext(text,start,start+7),{before:'One. Two. ',exact:'Target.',after:' Four. Five. '})
const chinese='零。前一。前二。标记。后一。后二。不要。'
assert.equal(markContext(chinese,chinese.indexOf('标记'),chinese.indexOf('标记')+3).after,'后一。后二。')
console.log('PASS read aloud: bilingual rates, three whole-selection repetitions, preferred online voices, pause/resume/stop, stale callbacks, local preferences/backup and two-sentence mark context')
