import { useSyncExternalStore } from 'react'
import { getSettingsSnapshot } from '../engine/settings-store'

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

type State = {status:'idle'|'speaking'|'paused'|'error'; owner?:string; voice?:string; lang?:string; rate?:number; repeat?:number; repeats?:number; error?:'unsupported'|'failed'}
let state: State = {status:'idle'}, generation = 0
let currentUtterance: SpeechSynthesisUtterance | null = null
const listeners = new Set<() => void>()
function publish(next: State) { state = next; listeners.forEach(fn=>fn()) }
export const speechSnapshot = () => state
export function useReadAloud() { return useSyncExternalStore(fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},speechSnapshot) }
export function stopReadAloud(owner?: string) {
  if (owner && state.owner !== owner) return
  generation++; currentUtterance = null
  try { const synth=window.speechSynthesis; synth?.cancel(); if(synth?.paused)synth.resume() } catch {}
  publish({status:'idle'})
}
export function pauseReadAloud() { if(state.status==='speaking') { window.speechSynthesis.pause();publish({...state,status:'paused'}) } }
export function resumeReadAloud() { if(state.status==='paused') { window.speechSynthesis.resume();publish({...state,status:'speaking'}) } }

export function readAloud(text: string, owner: string) {
  stopReadAloud()
  if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') { publish({status:'error',owner,error:'unsupported'}); return }
  const chunks = speechChunks(text)
  if (!chunks.length) return
  const token = generation
  const repeats = getSettingsSnapshot().speechRepeatCount ?? 3
  let index = 0
  let repeat = 1
  const next = () => {
    if (token !== generation) return
    if (index >= chunks.length && repeat < repeats) { index=0; repeat++ }
    const chunk = chunks[index++]
    if (!chunk) {currentUtterance=null;publish({status:'idle'});return}
    try {
      const utterance = new SpeechSynthesisUtterance(chunk.text)
      currentUtterance = utterance // retain until callbacks; some engines need a strong reference
      const voice = preferredVoice(window.speechSynthesis.getVoices(),chunk.lang)
      if (voice) utterance.voice = voice
      utterance.lang = chunk.lang; utterance.rate = chunk.rate
      utterance.onend = () => { if (currentUtterance === utterance) next() }
      utterance.onerror = () => { if(token===generation && currentUtterance===utterance) {currentUtterance=null;publish({status:'error',owner,error:'failed'})} }
      publish({status:'speaking',owner,voice:voice?.name,lang:chunk.lang,rate:chunk.rate,repeat,repeats})
      window.speechSynthesis.speak(utterance)
    } catch { if(token===generation) publish({status:'error',owner,error:'failed'}) }
  }
  next()
}
