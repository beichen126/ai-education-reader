import {requestWithImageKeys, type ImageKey} from './key-pool'
import {getSetting, setSetting} from '../storage/storage'

export type WebImage = {imageUrl: string; sourceUrl: string; title: string; creditsUsed?: number}
const pending = new Map<string, Promise<WebImage>>()
function safeUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('搜索结果缺少图片或来源地址')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('搜索结果地址无效')
  return url.href
}
export async function requestFirstImage(query: string, apiKey: string, signal?: AbortSignal): Promise<WebImage> {
  if (!apiKey.trim()) throw new Error('请先配置 Firecrawl API Key')
  const response = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey.trim()},
    body: JSON.stringify({query, sources: ['images'], limit: 1}), signal,
  })
  if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'Key 验证失败' : response.status === 402 ? '额度不足' : `请求失败（HTTP ${response.status}）`), {status: response.status})
  const data = await response.json()
  const first = data?.data?.images?.[0]
  if (!data.success || !first) throw new Error('本次搜索没有图片结果')
  return {imageUrl: safeUrl(first.imageUrl), sourceUrl: safeUrl(first.url), title: String(first.title || query).slice(0, 300), ...(typeof data.creditsUsed === 'number' ? {creditsUsed: data.creditsUsed} : {})}
}
/** Persist selected references with the reader data, without storing provider keys in cache IDs. */
export async function searchFirstImage(query: string, keys: ImageKey[]): Promise<WebImage> {
  if (!keys.length) throw new Error('请先配置 Firecrawl API Key')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(query.trim()))
  const id = 'web-image:' + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
  const cached = await getSetting(id)
  if (cached?.imageUrl && cached?.sourceUrl) return {...cached, imageUrl: safeUrl(cached.imageUrl), sourceUrl: safeUrl(cached.sourceUrl)}
  const inFlight = pending.get(id)
  if (inFlight) return inFlight
  const promise = (async () => {
    const image = await requestWithImageKeys(keys, key => requestFirstImage(query, key, AbortSignal.timeout(20000)))
    await setSetting(id, image)
    return image
  })().finally(() => pending.delete(id))
  pending.set(id, promise)
  return promise
}
