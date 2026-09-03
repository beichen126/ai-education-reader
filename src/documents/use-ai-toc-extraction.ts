// AI TOC extraction orchestration (Stage 9.4B). Runs the vision pipeline for the
// selected TOC pages and returns an UNTRUSTED mapped draft for human review. AI is
// never the persistence authority — nothing here writes a Document. A deterministic
// test seam (window.__dshMockAiToc) lets browser e2e validate the flow without a
// real paid API call.
import { renderSessionPage } from '../pdf/pdf-session'
import type { PdfSession } from '../pdf/pdf-session'
import { sendTextChat, type ApiChatMessage } from '../api/deepseek'
import { parseAiToc, mergeAiTocChunks, chunkTocPages, TOC_VISION_PAGES_PER_CHUNK, type AiTocEntry } from './ai-toc'
import { buildInitialMapping, labelsArePlainNumeric, type MappedTocItem } from './toc-mapping'

export type AiTocExtractionResult =
  | { ok: true; items: MappedTocItem[]; labels: string[] | null; labelsPlainNumeric: boolean }
  | { ok: false; error: string }

const TOC_SYSTEM_PROMPT =
  '你是 PDF 目录识别助手。只输出 JSON，不要输出任何解释或代码块。' +
  '逐条抄录目录中的章节，不概括、不遗漏、不编造。每条为：' +
  '{"title":"完整章节标题","level":层级数字,"pageLabel":"目录上印的页码原样字符串","tocPage":该目录条目所在的物理PDF页号}。' +
  '按原顺序输出一个 JSON 数组。无法判断页码时 pageLabel 给原始文本。'

export async function extractAiToc(opts: {
  session: PdfSession
  pageCount: number
  selectedPages: number[]
  apiKey: string
  baseUrl: string
  model: string
  getPageLabels: () => Promise<string[] | null>
  signal?: AbortSignal
}): Promise<AiTocExtractionResult> {
  const { session, selectedPages, apiKey, baseUrl, model, getPageLabels, signal } = opts

  const mock = (globalThis as any).__dshMockAiToc as (request: { pages: number[] }) => string | undefined
  if (typeof mock === 'function') {
    // Deterministic test path: build entries directly from the requested pages.
    const chunks = chunkTocPages(selectedPages)
    const entries: AiTocEntry[] = []
    for (const chunk of chunks) {
      const raw = mock({ pages: chunk })
      if (typeof raw === 'string') {
        const r = parseAiToc(raw)
        if (!r.ok) return { ok: false, error: 'directory parse failed' }
        entries.push(...(r as { ok: true; entries: AiTocEntry[] }).entries)
      }
    }
    const merged = mergeAiTocChunks([entries])
    const labels = await getPageLabels()
    const items = buildInitialMapping(merged, labels)
    return { ok: true, items, labels, labelsPlainNumeric: labelsArePlainNumeric(labels) }
  }

  if (!apiKey) return { ok: false, error: 'AI 目录识别需要配置 API Key。' }

  // Render each selected TOC page to a small data URL (never persisted).
  const pageDataUrls: Record<number, string> = {}
  for (const n of selectedPages) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    try {
      const r = await renderSessionPage(session, n)
      const url = await new Promise<string>((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject('render'); fr.readAsDataURL(r.blob) })
      pageDataUrls[n] = url
    } catch { return { ok: false, error: '第 ' + n + ' 页渲染失败，无法用于目录识别。' } }
  }

  const chunks = chunkTocPages(selectedPages)
  const merged: AiTocEntry[] = []
  for (const chunk of chunks) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    const parts = chunk.map(n => ({ type: 'image_url' as const, image_url: { url: pageDataUrls[n] } }))
    const messages: ApiChatMessage[] = [
      { role: 'system', content: TOC_SYSTEM_PROMPT },
      { role: 'user', content: parts },
    ]
    let res
    try { res = await sendTextChat({ apiKey, baseUrl, model, messages }) }
    catch (e) { return { ok: false, error: (e instanceof Error && e.message) ? e.message : '目录识别请求失败。' } }
    const parsed = parseAiToc(res.content)
    if (!parsed.ok) return { ok: false, error: 'directory parse failed' }
    merged.push(...(parsed as { ok: true; entries: AiTocEntry[] }).entries)
  }

  const deduped = mergeAiTocChunks([merged])
  const labels = await getPageLabels()
  const items = buildInitialMapping(deduped, labels)
  return { ok: true, items, labels, labelsPlainNumeric: labelsArePlainNumeric(labels) }
}
