export type OcrPage = { text: string; finishReason: 'stop' | 'length'; recognizedAt: number }

/** OCR is a standalone official service, never routed through the chat provider. */
export async function recognizeDeepSeekPage(blob: Blob, apiKey: string): Promise<OcrPage> {
  if (!apiKey.trim()) throw new Error('请先在 API 配置中保存一个 DeepSeek 官方配置和 Key。')
  if (!blob.size || blob.size > 100 * 1024 * 1024) throw new Error('OCR 文件必须大于 0 且不超过 100 MiB。')
  const form = new FormData()
  form.append('purpose', 'text_recognition')
  form.append('file', blob, 'page.jpg')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 190000)
  try {
    const response = await fetch('https://api.deepseek.com/v1/tools/ocr', {
      method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: form, signal: controller.signal,
    })
    const data = await response.json()
    if (!response.ok || data.error) throw new Error('DeepSeek OCR 失败（HTTP ' + response.status + '）：' + (typeof data.error?.message === 'string' ? data.error.message.slice(0, 300) : '请检查密钥、余额或稍后重试。'))
    if (data.object !== 'ocr.result' || data.page_count !== 1 || !Array.isArray(data.pages) || data.pages.length !== 1 || data.pages[0].index !== 0 || typeof data.pages[0].text !== 'string' || !['stop', 'length'].includes(data.pages[0].finish_reason)) throw new Error('DeepSeek OCR 返回的页面结果无效。')
    return { text: data.pages[0].text, finishReason: data.pages[0].finish_reason, recognizedAt: Date.now() }
  } finally { clearTimeout(timer) }
}

export function validOcrPage(value: unknown): value is OcrPage {
  const p = value as OcrPage | null
  return !!p && typeof p.text === 'string' && ['stop', 'length'].includes(p.finishReason) && Number.isFinite(p.recognizedAt) && p.recognizedAt >= 0
}

export function ocrContextText(page: OcrPage, name: string): string {
  // Strip positional metadata, retain the actual recognized content and formulas.
  const text = page.text.replace(/<｜box｜>[\s\S]*?<｜\/box｜>/g, '').replace(/<｜\/?(?:ref|det)｜>/g, '').trim()
  return '【PDF OCR · ' + name + '】\n以下文字来自此 PDF 页面的 OCR 识别。\n' + (text || '（本页未识别出文字）') + (page.finishReason === 'length' ? '\n【注意：本页 OCR 达到输出上限，文字不完整。】' : '')
}
