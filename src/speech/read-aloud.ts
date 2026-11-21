import {cachedSpeechAudio,evictSpeechAudio} from './audio-cache'
import {selectedDeepSeekServiceProfile} from '../engine/deepseek-service-profile'
import { useSyncExternalStore } from 'react'
import { getSettingsSnapshot } from '../engine/settings-store'
import { tx } from '../engine/locale'

type AndroidSpeechWindow = Window & { AndroidTTS?: { offlineOnly?: () => boolean }; __androidTtsInstalled?: boolean }

export function hasAndroidVocabularySpeech(): boolean {
  const host = typeof window === 'undefined' ? undefined : window as AndroidSpeechWindow
  return host?.__androidTtsInstalled === true && host.AndroidTTS?.offlineOnly?.() === true
}

export type SpeechChunk = {text: string; lang: 'zh-CN' | 'en-US'; rate: number}
export function speechChunks(text: string): SpeechChunk[] {
  const sentences = typeof Intl.Segmenter==='function' ? [...new Intl.Segmenter(undefined,{granularity:'sentence'}).segment(text.trim())].map(item=>item.segment) : text.trim().match(/[^。！？.!?\n]+[。！？.!?]*|\n/g) ?? []
  const result: SpeechChunk[] = []
  for (const sentence of sentences) {
    // Sentence-level detection handles bilingual paragraphs without switching
    // voice on every borrowed English term inside a Chinese sentence.
    const chinese = (sentence.match(/\p{Script=Han}/gu) ?? []).length
    const english = (sentence.match(/[a-z]/gi) ?? []).length
    const lang = chinese > 0 && chinese * 2 >= english ? 'zh-CN' : 'en-US'
    const preferences = getSettingsSnapshot()
    const chars = Array.from(sentence)
    for (let i = 0; i < chars.length; i += 220) {
      const chunk = chars.slice(i, i + 220).join('').trim()
      if (chunk) result.push({text:chunk,lang,rate:lang === 'zh-CN' ? preferences.chineseSpeechRate ?? 1 : preferences.englishSpeechRate ?? 0.9})
    }
  }
  return result
}

export function preferredVoice(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | undefined {
  const language = lang.split('-')[0].toLowerCase()
  const candidates = voices.filter(voice => voice.lang.toLowerCase().split(/[-_]/)[0] === language)
  const score = (voice: SpeechSynthesisVoice) => (voice.lang.toLowerCase() === lang.toLowerCase() ? (language==='zh'?32:8) : 0) + (/microsoft/i.test(voice.name) ? 4 : 0) + (/online|natural/i.test(voice.name) ? 16 : 0) + (voice.default ? 1 : 0)
  return [...candidates].sort((a,b) => score(b)-score(a))[0]
}

type State = {status:'idle'|'loading'|'speaking'|'paused'|'error'; owner?:string; voice?:string; lang?:string; rate?:number; repeat?:number; repeats?:number; loop?:boolean; error?:string; offline?:boolean}
let state: State = {status:'idle'}, generation = 0
let audio: HTMLAudioElement | null = null
let urls: string[] = []
let liveRate: number | undefined
let androidSpeech: SpeechSynthesis | undefined
let androidUtterance: SpeechSynthesisUtterance | undefined
const listeners = new Set<() => void>()
function publish(next: State) { state = next; listeners.forEach(fn=>fn()) }
export const speechSnapshot = () => state
export function useReadAloud() { return useSyncExternalStore(fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},speechSnapshot) }
export function stopReadAloud(owner?: string) {
  if (owner && state.owner !== owner) return
  generation++;liveRate=undefined
  androidSpeech?.cancel()
  androidSpeech=undefined
  androidUtterance=undefined
  if(audio){audio.onended=null;audio.onerror=null;audio.pause();audio.removeAttribute('src');audio.load();audio=null}
  urls.forEach(url=>URL.revokeObjectURL(url));urls=[]
  publish({status:'idle'})
}
export function pauseReadAloud() {
  if(state.status!=='speaking')return
  if(androidSpeech)androidSpeech.pause()
  else if(audio)audio.pause()
  else return
  publish({...state,status:'paused'})
}
export function resumeReadAloud() {
  if(state.status==='paused' && androidSpeech){
    androidSpeech.resume()
    publish({...state,status:'speaking'})
    return
  }
  if(state.status!=='paused' || !audio)return
  const token=generation
  void audio.play().then(()=>{if(token===generation)publish({...state,status:'speaking'})}).catch(()=>{if(token===generation)publish({...state,status:'error',error:'浏览器阻止播放，请再次点击朗读。'})})
}

export function readAndroidVocabulary(text: string, lang: string, owner: string) {
  stopReadAloud()
  const synth = window.speechSynthesis
  const tag = lang.toLowerCase()
  const voice = synth.getVoices().filter(candidate => candidate.localService &&
    (candidate.lang.toLowerCase() === tag || (!tag.includes('-') && candidate.lang.toLowerCase().split('-')[0] === tag)))
    .sort((a,b) => Number(b.default) - Number(a.default))[0]
  const fail = () => {
    stopReadAloud()
    publish({status:'error',owner,offline:true,error:tx(
      '无法使用 '+lang+' 离线语音。请在系统「文字转语音」里选择支持该语言的引擎并下载语音包。',
      'Offline voice unavailable for '+lang+'. Select a compatible text-to-speech engine in system settings and download its voice.',
    )})
  }
  if(!voice){fail();return}
  const settings = getSettingsSnapshot()
  const repeats = settings.speechRepeatCount ?? 3
  const loop = settings.speechLoop ?? false
  const token = generation
  let repeat = 1
  androidSpeech = synth
  const next = () => {
    const utterance = new SpeechSynthesisUtterance(text)
    androidUtterance = utterance
    utterance.lang = voice.lang
    utterance.voice = voice
    utterance.rate = liveRate ?? (tag.startsWith('zh') ? settings.chineseSpeechRate ?? 1 : tag.startsWith('en') ? settings.englishSpeechRate ?? 0.9 : 1)
    const current = {owner,lang:voice.lang,voice:voice.name,rate:utterance.rate,repeat,repeats,loop,offline:true}
    const active = () => token === generation && androidUtterance === utterance
    utterance.onstart = () => { if(active())publish({...current,status:'speaking'}) }
    utterance.onerror = () => { if(active())fail() }
    utterance.onend = () => {
      if(!active() || state.status==='paused')return
      if(++repeat > repeats && !loop)stopReadAloud()
      else next()
    }
    publish({...current,status:'loading'})
    synth.speak(utterance)
  }
  next()
}
export function ttsChunks(text: string): string[] {
  // <= 3,600 billed characters and <= 22 KB JSON even for escaped input.
  const chars=Array.from(text.trim()), chunks:string[]=[]
  for(let i=0;i<chars.length;i+=1800) chunks.push(chars.slice(i,i+1800).join(''))
  return chunks
}
export function ttsEndpoint(base: string): string {
  const raw=(base || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
  const url=new URL(raw)
  if(!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)throw new Error('朗读 API 地址须为 HTTP(S) 地址，不能包含账号、查询参数或片段。')
  if(url.pathname.endsWith('/tools/tts'))return raw
  return raw.replace(/\/(?:v1|beta)$/, '') + '/v1/tools/tts'

}
export function setReadAloudRate(owner: string, rate: number) {
  if (state.owner !== owner || !Number.isFinite(rate) || rate < 0.5 || rate > 2) return
  liveRate = rate
  if (audio) audio.playbackRate = rate
  publish({ ...state, rate })
}
export function readAloud(text: string, owner: string, options: { rate?: number; repeats?: number; loop?:boolean; voice?: 'stella' | 'tide'; apiKey?: string; onStarted?: () => void } = {}) {
  stopReadAloud()
  const chunks=ttsChunks(text)
  if(!chunks.length)return
  const settings=getSettingsSnapshot(), token=generation
  const apiKey=options.apiKey ?? selectedDeepSeekServiceProfile()?.config.apiKey
  const voice=options.voice || settings.speechVoice || 'stella'
  const voiceName=voice==='tide'?'DeepSeek · Tide':'DeepSeek · Stella'
  if(!apiKey){publish({status:'error',owner,error:'请先在设置中配置 DeepSeek API Key。'});return}
  const player=new Audio();audio=player
  const repeats=options.repeats ?? settings.speechRepeatCount ?? 3, loop=options.loop ?? settings.speechLoop ?? false
  let index=0, repeat=1
  const fail=(error: unknown)=>{
    if(token!==generation)return
    stopReadAloud()
    publish({status:'error',owner,error:error instanceof Error ? error.message : '语音合成或播放失败，请重试。'})
  }
  async function next() {
    if(token!==generation)return
    if(index>=chunks.length){index=0;repeat++;if(!loop&&repeat>repeats){stopReadAloud();return}}
    const current=index++
    const lang=/\p{Script=Han}/u.test(chunks[current])?'zh-CN':'en-US'
    const rate=liveRate ?? options.rate ?? (lang==='zh-CN' ? settings.chineseSpeechRate ?? 1 : settings.englishSpeechRate ?? 0.9)
    publish({status:'loading',owner,voice:voiceName,lang,rate,repeat,repeats,loop})
    try {
      const blob=await cachedSpeechAudio(ttsEndpoint('https://api.deepseek.com'),apiKey!,chunks[current],voice)
      if(token!==generation)return
      urls.forEach(old=>URL.revokeObjectURL(old));urls=[]
      const url=URL.createObjectURL(blob);urls.push(url)
      player.src=url;player.playbackRate=state.owner===owner ? state.rate ?? rate : rate
      player.onended=()=>{void next()}
      player.onerror=()=>{void evictSpeechAudio(ttsEndpoint('https://api.deepseek.com'),apiKey!,chunks[current],voice).catch(()=>{});fail(new Error('音频无法播放或数据不完整，请重试。'))}
      await player.play()
      if(token===generation) {
        publish({status:'speaking',owner,voice:voiceName,lang,rate:player.playbackRate,repeat,repeats,loop})
        if (current === 0 && repeat === 1) options.onStarted?.()
      }
    } catch(error){fail(error)}
  }
  void next()
}
