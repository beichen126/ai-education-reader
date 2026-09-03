// AI TOC extraction orchestration (Stage 9.4B). Runs the vision pipeline for the
// selected TOC pages and returns an UNTRUSTED mapped draft for human review. AI is
// never the persistence authority — nothing here writes a Document. A deterministic
// test seam (window.__dshMockAiToc) lets browser e2e validate the flow without a
// real paid API call.
import { renderSessionPage } from '../pdf/pdf-session'
import type { PdfSession } from '../pdf/pdf-session'
import { sendTextChat, type ApiChatMessage } from '../api/deepseek'
import { parseTocJsonl, parseTocStructure, validateTocStructure, assignLocalRowIds, type TocTranscriptionRow } from './ai-toc'
import { buildInitialMapping, labelsArePlainNumeric, type MappedTocItem } from './toc-mapping'

export type AiTocExtractionResult =
  | { ok: true; items: MappedTocItem[]; labels: string[] | null; labelsPlainNumeric: boolean }
  | { ok: false; error: string }

const TOC_STRUCTURE_PROMPT =
  '你是 PDF 目录结构分析助手。输入是逐行目录转录（含阅读顺序、缩进、编号）。' +
  '只输出 JSONL：每一行{"id":"行id","level":绝对层级数字}。不得修改 title/pageLabel/顺序/编号。' +
  '按输入顺序为每个 id 给出 level。只输出 JSONL，不要解释。'

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

  // ---- Flat transcription -> global structure (Stage 9.4C) ----
  // Vision batches OUTPUT FLAT transcription rows (never absolute levels). A separate
  // GLOBAL structure pass (text-only) proposes levels across the whole row set.
  const transcriptTranscribe = async (pageBatch: number[], pageDataUrls: Record<number, string>): Promise<TocTranscriptionRow[]> => {
    const mock = (globalThis as any).__dshMockAiToc as ((request: { pages: number[]; phase: 'transcribe' | 'structure' }) => string | undefined) | undefined
    if (typeof mock === 'function') {
      const raw = mock({ pages: pageBatch, phase: 'transcribe' })
      if (typeof raw !== 'string') return []
      const r = parseTocJsonl(raw)
      if (!r.ok) { const d = (r as { diagnostics: string[] }).diagnostics; throw new Error(d.length ? d[0] : '目录识别结果格式异常，请重试。') }
      const { rows } = r
      const assigned = assignLocalRowIds(rows)
      // Keep batch order stable across chunks by re-indexing after global collection.
      return assigned
    }
    // Real path: request each page batch as JSONL transcription.
    const parts = pageBatch.map(n => ({ type: 'image_url' as const, image_url: { url: pageDataUrls[n] } }))
    const messages: ApiChatMessage[] = [{ role: 'system', content: TOC_SYSTEM_PROMPT }, { role: 'user', content: parts }]
    const res = await sendTextChat({ apiKey, baseUrl, model, messages })
    const r = parseTocJsonl(res.content)
    if (!r.ok) { const d = (r as { diagnostics: string[] }).diagnostics; throw new Error(d.length ? d[0] : '目录识别结果格式异常，请重试。') }
    return assignLocalRowIds(r.rows)
  }

  const labels = await getPageLabels()

  if (!apiKey && typeof (globalThis as any).__dshMockAiToc !== 'function') return { ok: false, error: 'AI 目录识别需要配置 API Key。' }

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

  // Small TOC (<=8 selected pages): one request sees full continuity. Larger: sequential
  // windows (6-8) — but each window is only a TRANSCRIPTION batch, never a tree batch.
  const windowSize = selectedPages.length <= 8 ? selectedPages.length : 8
  const windows: number[][] = []
  for (let i = 0; i < selectedPages.length; i += windowSize) windows.push(selectedPages.slice(i, i + windowSize))
  let allRows: TocTranscriptionRow[] = []
  for (const w of windows) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    try { allRows = allRows.concat(await transcriptTranscribe(w, pageDataUrls)) }
    catch (e) { return { ok: false, error: (e instanceof Error && e.message) ? e.message : '目录识别请求失败。' } }
  }
  // Re-index to stable contiguous r0001… (merge keeps line order; ids are local).
  allRows = assignLocalRowIds(allRows.map((r, i) => ({ ...r, rowOrder: i })))
  if (allRows.length === 0) return { ok: false, error: '未识别到目录条目。' }

  // GLOBAL structure pass: text-only, proposes {id, level} per row; cannot modify title/page.
  const mock2 = (globalThis as any).__dshMockAiToc
  let structureRaw: string | undefined
  if (typeof mock2 === 'function') { structureRaw = mock2({ pages: [], phase: 'structure' }) }
  else {
    const seq = allRows.map(r => r.id + ' | ' + r.title + ' | indent ' + (r.visualIndent ?? '-') + ' | ' + (r.numbering ?? '-') + ' | p' + r.pageLabel).join('\n')
    const messages: ApiChatMessage[] = [{ role: 'system', content: TOC_STRUCTURE_PROMPT }, { role: 'user', content: seq }]
    try { const res = await sendTextChat({ apiKey, baseUrl, model, messages }); structureRaw = res.content } catch (e) { return { ok: false, error: (e instanceof Error && e.message) ? e.message : '目录结构分析失败。' } }
  }
  const sp = parseTocStructure(structureRaw || '')
  if (!sp.ok) return { ok: false, error: '目录结构分析失败，请重试或进入手动编辑。' }
  const sv = validateTocStructure(allRows, sp.proposals)
  if (!sv.ok) return { ok: false, error: '目录结构分析失败，请重试或进入手动编辑。' }
  const leveled = allRows.map((r, i) => ({ title: r.title, level: sv.levels[i], pageLabel: r.pageLabel, tocPage: r.tocPage }))
  const items = buildInitialMapping(leveled, labels)
  return { ok: true, items, labels, labelsPlainNumeric: labelsArePlainNumeric(labels) }
}
