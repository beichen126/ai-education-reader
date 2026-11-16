/** Local audio only: bounded, seven-day LRU cache. Keys never contain API keys or text. */
const TTL=7*24*60*60*1000,MAX_BYTES=32*1024*1024,MAX_ENTRIES=128
export const SPEECH_CACHE_POLICY={ttlMs:TTL,maxBytes:MAX_BYTES,maxEntries:MAX_ENTRIES}
type Entry={key:string;blob:Blob;createdAt:number;accessedAt:number;size:number}
const fallback=new Map<string,Entry>(),pending=new Map<string,Promise<Blob>>(),controllers=new Set<AbortController>();let epoch=0
async function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open('reader-speech-cache',1);r.onupgradeneeded=()=>r.result.createObjectStore('audio',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function stored(key:string):Promise<Entry|undefined>{if(fallback.has(key))return fallback.get(key);try{const db=await database();try{return await new Promise((resolve,reject)=>{const r=db.transaction('audio').objectStore('audio').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}}catch{return fallback.get(key)}}
function retained(entries:Entry[]){let bytes=0;return entries.filter(e=>e.blob instanceof Blob&&e.size===e.blob.size&&e.createdAt>Date.now()-TTL).sort((a,b)=>b.accessedAt-a.accessedAt).filter((e,i)=>{bytes+=e.size;return i<MAX_ENTRIES&&bytes<=MAX_BYTES})}
async function save(entry:Entry,token:number){if(token!==epoch)return;try{const db=await database();try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('audio','readwrite'),store=tx.objectStore('audio');const r=store.getAll();r.onsuccess=()=>{if(token!==epoch){tx.abort();return}const all=(r.result as Entry[]).filter(e=>e.key!==entry.key);const keep=retained([entry,...all]);const ids=new Set(keep.map(e=>e.key));for(const e of all)if(!ids.has(e.key))store.delete(e.key);if(ids.has(entry.key))store.put(entry)};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}finally{db.close()}}catch{if(token!==epoch)return;const keep=retained([entry,...[...fallback.values()].filter(e=>e.key!==entry.key)]);fallback.clear();for(const e of keep)fallback.set(e.key,e)}}
export async function clearSpeechCache(){epoch++;for(const c of controllers)c.abort();controllers.clear();pending.clear();fallback.clear();const db=await database().catch(()=>undefined);if(!db)return;try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('audio','readwrite');tx.objectStore('audio').clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}finally{db.close()}}
async function audioKey(endpoint:string,apiKey:string,text:string,voice:string){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([endpoint,apiKey,text,voice,'wav',true])));return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('')}
export async function evictSpeechAudio(endpoint:string,apiKey:string,text:string,voice:string){const key=await audioKey(endpoint,apiKey,text,voice);fallback.delete(key);const db=await database().catch(()=>undefined);if(!db)return;try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('audio','readwrite');tx.objectStore('audio').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}finally{db.close()}}
export async function cachedSpeechAudio(endpoint:string,apiKey:string,text:string,voice:string):Promise<Blob>{
 const key=await audioKey(endpoint,apiKey,text,voice);
 const active=pending.get(key);if(active)return active;
 const token=epoch;
 const promise=(async()=>{
  const old=await stored(key);if(old&&old.blob instanceof Blob&&old.size===old.blob.size&&old.createdAt>Date.now()-TTL){await save({...old,accessedAt:Date.now()},token);return old.blob}
  if(token!==epoch)throw new Error('语音缓存已清理，请重新播放。');
  const c=new AbortController();controllers.add(c);const timer=setTimeout(()=>c.abort(),120000);
  try{
   const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({text,voice_id:voice,format:'wav',filter_markdown:true}),signal:c.signal});
   if(!response.ok)throw new Error('DeepSeek 朗读请求失败（HTTP '+response.status+'），请检查 API Key、余额或稍后重试。');
   const blob=await response.blob();if(blob.size<44||blob.size>16*1024*1024)throw new Error('返回的语音大小异常，请重试。');
   const bytes=new Uint8Array(await blob.slice(0,12).arrayBuffer());const marker=(a:number,b:number)=>String.fromCharCode(...bytes.slice(a,b));
   if(marker(0,4)!=='RIFF'||marker(8,12)!=='WAVE')throw new Error('服务未返回有效 WAV 音频，请重试。');
   if(token!==epoch)throw new Error('语音缓存已清理，请重新播放。');
   await save({key,blob,size:blob.size,createdAt:Date.now(),accessedAt:Date.now()},token);return blob;
  }finally{clearTimeout(timer);controllers.delete(c)}
 })();pending.set(key,promise);try{return await promise}finally{if(pending.get(key)===promise)pending.delete(key)}
}
