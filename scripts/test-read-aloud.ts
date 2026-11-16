import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { ttsChunks, ttsEndpoint, speechChunks, preferredVoice, readAloud, speechSnapshot, stopReadAloud, pauseReadAloud, resumeReadAloud } from '../src/speech/read-aloud.ts'
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
const players: any[]=[]
class Player {onended:any;onerror:any;src='';playbackRate=1;pause(){}load(){}removeAttribute(){} async play(){} constructor(){players.push(this)}}
Object.assign(globalThis,{Audio:Player})
readAloud('hello','missing');assert.match(speechSnapshot().error!,/API Key/)
await patchSettings({apiKey:'test-key',apiBaseUrl:'https://api.deepseek.com/v1'})
let calls=0
Object.assign(globalThis,{fetch:async(url:string,init:any)=>{calls++;assert.equal(url,'https://api.deepseek.com/v1/tools/tts');assert.equal(init.headers.Authorization,'Bearer test-key');assert.equal(JSON.parse(init.body).filter_markdown,true);return new Response(new Uint8Array(100),{headers:{'Content-Type':'audio/wav'}})}})
const settle=()=>new Promise(r=>setTimeout(r,10))
readAloud('你好。 Hello.','owner');await settle()
assert.equal(speechSnapshot().status,'speaking')
pauseReadAloud();assert.equal(speechSnapshot().status,'paused')
resumeReadAloud();await settle();assert.equal(speechSnapshot().status,'speaking')
players.at(-1).onended();await settle();assert.equal(speechSnapshot().repeat,2)
players.at(-1).onended();await settle();assert.equal(speechSnapshot().repeat,3)
players.at(-1).onended();await settle();assert.equal(speechSnapshot().status,'idle');assert.equal(calls,1)
assert.equal(ttsChunks('中'.repeat(9000)).length,5)
assert.equal(ttsEndpoint('https://api.deepseek.com/'),'https://api.deepseek.com/v1/tools/tts')
let resolve:any
Object.assign(globalThis,{fetch:()=>new Promise(r=>{resolve=r})})
readAloud('cancel','old');stopReadAloud();resolve(new Response(new Uint8Array(100)));await settle();assert.equal(speechSnapshot().status,'idle')
Object.assign(globalThis,{fetch:async()=>new Response('',{status:401})})
readAloud('error','new');await settle();assert.match(speechSnapshot().error!,/401/)
stopReadAloud()
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
console.log('PASS DeepSeek TTS: auth, endpoint, repeat cache, pause/resume, cancellation, errors, chunking, preferences and backup')

await patchSettings({speechVoice:'tide',apiKey:'official-test',speechApiUrl:'https://api.teamorouter.com/v1',speechApiKey:'relay-test'})
await initSettings()
assert.equal(getSettingsSnapshot().speechVoice,'tide')
Object.assign(globalThis,{fetch:async(url:string,init:any)=>{assert.equal(url,'https://api.deepseek.com/v1/tools/tts');assert.equal(init.headers.Authorization,'Bearer official-test');assert.equal(JSON.parse(init.body).voice_id,'tide');return new Response(new Uint8Array(100))}})
readAloud('relay','relay');await settle();assert.equal(speechSnapshot().status,'speaking');stopReadAloud()
assert.equal(ttsEndpoint('https://relay.example/custom/v1/tools/tts'),'https://relay.example/custom/v1/tools/tts')
assert.throws(()=>ttsEndpoint('javascript:alert(1)'))
const speechBackup=await buildBackup()
assert.equal(speechBackup.settings.speechVoice,'tide')
assert.equal(JSON.stringify(speechBackup).includes('relay-test'),false)
await restoreBackup(parseAndValidate(speechBackup));await initSettings()
assert.equal(getSettingsSnapshot().speechApiKey,'')
assert.equal(getSettingsSnapshot().speechVoice,'tide')
console.log('PASS voice selection, official endpoint ignores legacy relay URL/key, persistence and credential-free backup')

const {pcmWav}=await import('../src/speech/transcribe')
const wav=new DataView(await pcmWav(new Float32Array([-1,0,1])).arrayBuffer())
assert.equal(wav.getUint32(24,true),16000)
assert.equal(wav.getInt16(44,true),-32768)
assert.equal(wav.getInt16(48,true),32767)
console.log('PASS ASR PCM WAV encoding')

const {transcribeAudio}=await import('../src/speech/transcribe')
await patchSettings({speechApiUrl:'',apiKey:'official-test',apiBaseUrl:'https://api.teamorouter.com/v1'})
Object.assign(globalThis,{AudioContext:class{async decodeAudioData(){return {duration:1}}async close(){}},OfflineAudioContext:class{destination={};createBufferSource(){return {connect(){},start(){}}}async startRendering(){return {getChannelData(){return new Float32Array(16000)}}}},fetch:async(url:string,init:any)=>{assert.equal(url,'https://api.deepseek.com/v1/tools/asr');assert.equal(init.headers.Authorization,'Bearer official-test');assert.equal(init.body.get('file').type,'audio/wav');return Response.json({text:'识别文字'})}})
assert.equal(await transcribeAudio(new Blob(['audio']),new AbortController().signal),'识别文字')
await assert.rejects(()=>transcribeAudio(new Blob([new Uint8Array(8*1024*1024+1)]),new AbortController().signal),/8 MiB/)
const aborted=new AbortController();aborted.abort()
await assert.rejects(()=>transcribeAudio(new Blob(['audio']),aborted.signal),/Aborted/)
console.log('PASS ASR official default, current API key, multipart WAV, cancellation and size limit')
