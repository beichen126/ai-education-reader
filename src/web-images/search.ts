import {requestWithImageKeys, type ImageKey} from './key-pool'
import {getSetting, setSetting} from '../storage/storage'

export type WebImage = {imageUrl: string; sourceUrl: string; title: string; creditsUsed?: number}
type Job = {promise: Promise<WebImage>; controller: AbortController; users: number; timer?: ReturnType<typeof setTimeout>}
const pending = new Map<string, Job>()
const memory = new Map<string, WebImage>()
let generation=0
export async function clearImageSearchRuntime() {
  generation++
  const jobs=[...pending.values()]
  for(const job of jobs){if(job.timer)clearTimeout(job.timer);job.controller.abort()}
  await Promise.allSettled(jobs.map(job=>job.promise))
  pending.clear();memory.clear()
}
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))), n=>n.toString(16).padStart(2,'0')).join('')
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
  if (!data.success || !first) throw Object.assign(new Error('本次搜索没有图片结果，请调整搜索描述。'),{terminal:true})
  return {imageUrl: safeUrl(first.imageUrl), sourceUrl: safeUrl(first.url), title: String(first.title || query).slice(0, 300), ...(typeof data.creditsUsed === 'number' ? {creditsUsed: data.creditsUsed} : {})}
}
/** Persist selected references with the reader data, without storing provider keys in cache IDs. */
export async function searchFirstImage(query: string, keys: ImageKey[], signal?: AbortSignal): Promise<WebImage> {
  const epoch=generation
  signal?.throwIfAborted()
  if (!keys.length) throw new Error('请先配置 Firecrawl API Key')
  const id = 'web-image:' + await hash(query.trim())
  const jobId = id + ':' + await hash(JSON.stringify(keys.map(k=>k.key)))
  signal?.throwIfAborted()
  if (memory.has(id)) return memory.get(id)!
  const cached = await getSetting(id).catch(()=>undefined)
  signal?.throwIfAborted()
  if (cached?.imageUrl && cached?.sourceUrl) {
    try {return {...cached,imageUrl:safeUrl(cached.imageUrl),sourceUrl:safeUrl(cached.sourceUrl)}} catch { /* Replace invalid cached references through a fresh search. */ }
  }
  if(epoch!==generation)throw new DOMException('已清除本地数据','AbortError')
  let job = pending.get(jobId)
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController()
    const deadline=AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])
    const created: Job = {controller,users:0,promise:Promise.resolve(undefined as never)}
    created.promise = (async()=>{
      const image = await requestWithImageKeys(keys, key=>requestFirstImage(query,key,AbortSignal.any([deadline,AbortSignal.timeout(20000)])),deadline)
      deadline.throwIfAborted()
      memory.set(id,image)
      if(memory.size>128) memory.delete(memory.keys().next().value!)
      await setSetting(id,image).catch(()=>undefined)
      return image
    })().finally(()=>{if(pending.get(jobId)===created)pending.delete(jobId);if(created.timer)clearTimeout(created.timer)})
    pending.set(jobId,created)
    job=created
  }
  const current=job
  current.users++
  if(current.timer)clearTimeout(current.timer)
  return new Promise<WebImage>((resolve,reject)=>{
    let done=false
    const finish=(error:unknown,value?:WebImage)=>{
      if(done)return
      done=true
      signal?.removeEventListener('abort',abort)
      current.users--
      if(!current.users && pending.get(jobId)===current) current.timer=setTimeout(()=>current.controller.abort(),150)
      if(error)reject(error);else resolve(value!)
    }
    const abort=()=>finish(signal?.reason || new DOMException('已取消','AbortError'))
    signal?.addEventListener('abort',abort,{once:true})
    if(signal?.aborted)abort()
    current.promise.then(value=>finish(null,value),error=>finish(error))
  })
}
