import type {Settings} from '../engine/settings-store'
import {getSetting, setSetting, deleteSetting} from '../storage/storage'
export type ImageKey = {name: string; key: string}
type KeyState = {reason: string; until: number}
export function configuredImageKeys(settings: Pick<Settings, 'firecrawlApiKey' | 'firecrawlKeys'>): ImageKey[] {
  const pool = settings.firecrawlKeys?.length ? settings.firecrawlKeys : [{name:'配置 1',key:settings.firecrawlApiKey || ''}]
  const seen = new Set<string>()
  return pool.filter(p => {const key = p.key.trim(); if (!key || seen.has(key)) return false; seen.add(key); return true}).map(p => ({name:p.name,key:p.key.trim()}))
}
async function stateId(key: string) {
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))
  return 'firecrawl-state:' + Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('')
}
export async function imageKeyState(key: string): Promise<KeyState | undefined> {return getSetting(await stateId(key))}
export async function resetImageKey(key: string) {await deleteSetting(await stateId(key)); await setSetting('firecrawl-cursor',await stateId(key))}
let queue: Promise<unknown> = Promise.resolve()
/** Serialize rotation across concurrent image positions. Three explicit quota failures advance a key; one full cycle bounds each search. */
export function requestWithImageKeys<T>(keys: ImageKey[], request: (key: string) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    if (!keys.length) throw new Error('请先配置 Firecrawl API Key')
    const ids = await Promise.all(keys.map(k => stateId(k.key)))
    const cursor = await getSetting('firecrawl-cursor')
    const start = Math.max(0,ids.indexOf(cursor))
    const failures: string[] = []
    for (let offset=0; offset<keys.length; offset++) {
      const index = (start+offset)%keys.length, entry = keys[index], id = ids[index]
      let quotaFailures = 0
      for (let attempt=0; attempt<3; attempt++) {
        try {
          const result = await request(entry.key)
          await deleteSetting(id)
          await setSetting('firecrawl-cursor',id)
          await setSetting('firecrawl-current',entry.name)
          return result
        } catch (error) {
          const status = (error as {status?: number})?.status
          if (status === 402) {quotaFailures++; if (quotaFailures<3) continue}
          const reason = quotaFailures===3 ? '连续 3 次额度耗尽，已轮换' : status===401 || status===403 ? '密钥验证失败，已轮换' : status===429 ? '请求频繁，已轮换' : '请求失败，已轮换（非额度判定）'
          await setSetting(id,{reason,until:Number.MAX_SAFE_INTEGER})
          failures.push(entry.name+'：'+reason)
          break
        }
      }
      await setSetting('firecrawl-cursor',ids[(index+1)%keys.length])
    }
    throw new Error('本轮配置均未成功。'+failures.join('；'))
  })
  queue = run.catch(()=>undefined)
  return run
}
