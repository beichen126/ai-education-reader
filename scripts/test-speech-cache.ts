import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {cachedSpeechAudio,clearSpeechCache,SPEECH_CACHE_POLICY} from '../src/speech/audio-cache.ts'
const bytes=new Uint8Array(64);bytes.set(new TextEncoder().encode('RIFF'));bytes.set(new TextEncoder().encode('WAVE'),8)
let calls=0,bad=false,release:(()=>void)|undefined
const original=globalThis.fetch,now=Date.now
try{
 globalThis.fetch=async()=>{calls++;if(release===undefined)await new Promise(r=>setTimeout(r,10));return new Response(bad?'invalid':bytes,{headers:{'Content-Type':'audio/wav'}})}
 await clearSpeechCache()
 const args=['https://api.deepseek.com/v1/tools/tts','key-a','hello','stella'] as const
 await Promise.all([cachedSpeechAudio(...args),cachedSpeechAudio(...args)]);assert.equal(calls,1,'concurrent synthesis coalesces')
 await cachedSpeechAudio(...args);assert.equal(calls,1,'replay uses persisted blob')
 await cachedSpeechAudio(args[0],args[1],args[2],'tide');assert.equal(calls,2,'voice identifies audio')
 await cachedSpeechAudio(args[0],'key-b',args[2],args[3]);assert.equal(calls,3,'credentials isolate cache')
 Date.now=()=>now()+SPEECH_CACHE_POLICY.ttlMs+1000;await cachedSpeechAudio(...args);assert.equal(calls,4,'expired audio resynthesizes');Date.now=now
 await clearSpeechCache();await cachedSpeechAudio(...args);assert.equal(calls,5,'clear invalidates persisted cache')
 bad=true;await assert.rejects(cachedSpeechAudio(args[0],args[1],'bad','stella'));await assert.rejects(cachedSpeechAudio(args[0],args[1],'bad','stella'));assert.equal(calls,7,'invalid responses never cached')
 bad=false;await Promise.all(Array.from({length:130},(_,i)=>cachedSpeechAudio(args[0],args[1],'bounded-'+i,'stella')))
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('reader-speech-cache',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
 const entries=await new Promise<any[]>((resolve,reject)=>{const r=db.transaction('audio').objectStore('audio').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();assert.ok(entries.length<=128);assert.ok(entries.reduce((n,e)=>n+e.size,0)<=32*1024*1024)
 console.log('PASS speech persistent reuse, concurrent dedup, voice/key isolation, TTL, clear and invalid-audio rejection')
}finally{globalThis.fetch=original;Date.now=now;await clearSpeechCache()}
