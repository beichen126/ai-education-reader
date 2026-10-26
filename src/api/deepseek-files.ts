import type { ApiChatMessage } from './deepseek'
import { tx } from '../engine/locale'

// Official DeepSeek only: compatible proxies must not inherit an assumed Files API.
export const DEEPSEEK_INLINE_BODY_BYTES = 48 * 1024 * 1024
export function isOfficialDeepSeek(baseUrl: string): boolean {
  try { return new URL(baseUrl || 'https://api.deepseek.com').origin === 'https://api.deepseek.com' } catch { return false }
}

export class DeepSeekFilesError extends Error {}

/** File IDs live only for this request, never in history/backups. Delete afterwards;
 * a one-hour server expiry also handles browser closure / interrupted cleanup. */
export async function prepareDeepSeekFiles(args: { baseUrl: string; apiKey: string; messages: ApiChatMessage[]; signal?: AbortSignal }, bodyBytes: number) {
  const noop = { messages: args.messages, cleanup: async () => {} }
  if (!isOfficialDeepSeek(args.baseUrl)) return noop
  const imageCount = args.messages.reduce((sum, m) => sum + (Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url' || p.type === 'file').length : 0), 0)
  if (imageCount > 600) throw new DeepSeekFilesError(tx('本次实际发送超过 DeepSeek 官方的 600 张图片上限。请减少发送页面；本地页面仍保留。', 'This request exceeds DeepSeek’s documented 600-image limit. Send fewer pages; local pages are preserved.'))
  const urls = [...new Set(args.messages.flatMap(m => Array.isArray(m.content)
    ? m.content.flatMap(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/') ? [p.image_url.url] : []) : []))]
  if (!urls.length) return noop
  // DeepSeek's separate inline per-image ceiling is 32 MiB; Files supports 64.
  const rawBytes = (url: string) => {
    const data = url.slice(url.indexOf(',') + 1)
    return data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  }
  if (bodyBytes <= DEEPSEEK_INLINE_BODY_BYTES && urls.every(url => rawBytes(url) <= 32 * 1024 * 1024)) return noop
  if (urls.some(url => rawBytes(url) > 64 * 1024 * 1024)) throw new DeepSeekFilesError(tx('单张图片超过 DeepSeek Files API 的 64 MiB 上限，请缩小该图片后重试。', 'An image exceeds the DeepSeek Files API 64 MiB limit. Resize that image and retry.'))
  const endpoint = (args.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/files'
  const ids = new Map<string, string>()
  const controller = new AbortController()
  const abort = () => controller.abort()
  args.signal?.addEventListener('abort', abort, { once: true })
  if (args.signal?.aborted) abort()
  const cleanup = async () => {
    args.signal?.removeEventListener('abort', abort)
    await Promise.allSettled([...ids.values()].map(id => fetch(endpoint + '/' + encodeURIComponent(id), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + args.apiKey }, signal: AbortSignal.timeout(5000),
    }).then(r => r.body?.cancel())))
  }
  let next = 0
  let firstFailure: unknown
  const workers = Array.from({ length: Math.min(5, urls.length) }, async () => {
    while (next < urls.length && !controller.signal.aborted) {
      const index = next++, url = urls[index], comma = url.indexOf(',')
      const mime = url.slice(5, url.indexOf(';'))
      const binary = atob(url.slice(comma + 1)), bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: mime }), 'page-' + (index + 1) + '.' + (mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]))
      form.append('purpose', 'user_data')
      form.append('expires_after[anchor]', 'created_at')
      form.append('expires_after[seconds]', '3600')
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + args.apiKey }, body: form, signal: controller.signal })
        if (!response.ok) throw new DeepSeekFilesError(tx('DeepSeek 图片上传失败（Files API，HTTP ' + response.status + '）。页面仍保存在本地，可重试。', 'DeepSeek Files API upload failed (HTTP ' + response.status + '). Local pages are preserved; retry the request.'))
        const file = await response.json()
        if (typeof file.id !== 'string' || !/^file-api-[A-Za-z0-9_-]+$/.test(file.id)) throw new DeepSeekFilesError(tx('DeepSeek Files API 未返回有效文件编号。', 'DeepSeek Files API returned an invalid file ID.'))
        ids.set(url, file.id)
      } catch (error) { firstFailure ??= error; controller.abort(); throw error }
    }
  })
  const results = await Promise.allSettled(workers)
  const failed = results.find(r => r.status === 'rejected')
  if (failed?.status === 'rejected' || args.signal?.aborted) {
    await cleanup()
    throw firstFailure ?? (failed?.status === 'rejected' ? failed.reason : new DOMException('Aborted', 'AbortError'))
  }
  return {
    messages: args.messages.map(m => ({ ...m, content: Array.isArray(m.content) ? m.content.map(p =>
      p.type === 'image_url' && ids.has(p.image_url.url) ? { type: 'file' as const, file_id: ids.get(p.image_url.url)! } : p) : m.content })),
    cleanup,
  }
}
