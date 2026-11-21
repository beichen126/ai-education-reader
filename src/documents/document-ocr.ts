import { idbGet, idbUpdate } from '../storage/idb'
import { recognizeDeepSeekPage, validOcrPage, type OcrPage } from '../api/deepseek-ocr'
import { selectedDeepSeekServiceProfile } from '../engine/deepseek-service-profile'

export async function readPageOcr(documentId: string, page: number): Promise<OcrPage | undefined> {
  const doc = await idbGet('documents', documentId)
  const result = doc?.ocrPages?.[page]
  return validOcrPage(result) ? result : undefined
}

const pending = new Map<string, Promise<OcrPage>>()
/** Cache on the immutable PDF record, atomically merge pages, and coalesce concurrent requests. */
export function ensurePageOcr(documentId: string, page: number, render: () => Promise<Blob>, acceptCached?: (page: OcrPage) => boolean): Promise<OcrPage> {
  const key = documentId + ':' + page
  const existing = pending.get(key)
  if (existing) return existing
  const run = async () => {
    const cached = await readPageOcr(documentId, page)
    if (cached && (!acceptCached || acceptCached(cached))) return cached
    const doc = await idbGet('documents', documentId)
    if (!doc || !Number.isInteger(page) || page < 1 || page > doc.pageCount) throw new Error('PDF 页面不存在，请先保存到资料库。')
    const profile = selectedDeepSeekServiceProfile()
    if (!profile) throw new Error('请先在 API 配置中保存一个 DeepSeek 官方配置和 Key；无需切换当前对话模型。')
    const result = await recognizeDeepSeekPage(await render(), profile.config.apiKey)
    await idbUpdate('documents', documentId, (current: any) => ({ ...current, ocrPages: { ...current.ocrPages, [page]: result } }))
    return result
  }
  const promise = (async () => typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request('pdf-ocr:' + key, run) : await run())().finally(() => pending.delete(key))
  pending.set(key, promise)
  return promise
}
