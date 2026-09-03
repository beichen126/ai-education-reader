// AI TOC extraction orchestration (Stage 9.4C.1). Runs the vision pipeline for the
// selected TOC pages and returns an UNTRUSTED mapped draft for human review. AI is
// never the persistence authority — nothing here writes a Document. A deterministic
// test seam (window.__dshMockAiToc) lets browser e2e validate the flow without a
// real paid API call.
//
// PROVENANCE: physical PDF pages are ALWAYS derived locally from the page batch via
// sourceImageIndex — the model NEVER returns a PDF page number. Each request embeds
// 【图片 k/N · PDF physical page P】 text identity before every image so the vision
// model can only report which image a row came from.
import { renderSessionPage } from '../pdf/pdf-session'
import type { PdfSession } from '../pdf/pdf-session'
import { sendTextChat, type ApiChatMessage } from '../api/deepseek'
import {
  parseTocJsonl, parseTocStructure, validateTocStructure, assignLocalRowIds,
  mapTocSourcePages, reindexRows,
  TOC_TRANSCRIPTION_SYSTEM_PROMPT, TOC_STRUCTURE_PROMPT,
  type TocTranscriptionRow, type TocLocalRow, type TocTranscriptionLine,
} from './ai-toc'
import { buildInitialMapping, labelsArePlainNumeric, type MappedTocItem } from './toc-mapping'

export type AiTocExtractionResult =
  | { ok: true; items: MappedTocItem[]; labels: string[] | null; labelsPlainNumeric: boolean }
  | { ok: false; error: string }



// ---- previous-tail continuity context (Stage 9.4C.1) ----
const PREV_TAIL_SIZE = 4
const LARGE_TOC_WINDOW = 8
const SMALL_TOC_MAX = 8

function buildTailContext(prevRows: TocTranscriptionRow[]): string {
  if (prevRows.length === 0) return ''
  const tail = prevRows.slice(-PREV_TAIL_SIZE)
  const lines2 = tail.map(r => r.id + ' | ' + r.title + ' | p' + r.pageLabel).join('\n')
  return '上一批最后几条目录转录，仅用于理解跨页连续性：\n' + lines2 + '\n请只转录当前图片中新出现的目录行。不要重新输出以上内容。';
}

function buildSequentialText(rows: TocTranscriptionRow[]): string {
  return rows.map(r => r.id + ' | ' + r.title + ' | indent ' + (r.visualIndent ?? '-') + ' | ' + (r.numbering ?? '-') + ' | p' + r.pageLabel).join('\n');
}

/**
 * Run the flat transcription -> global structure pipeline for one document.
 * `signal` is an AbortSignal: when aborted, no further request is started and
 * the result is { ok:false, error:'已取消' } (never a network-or-cors mislabel).
 * Retry contract: a malformed/schema-invalid transcription or structure result is
 * retried ONCE; a second failure aborts the whole extraction (no partial rows).
 */
export async function extractAiToc(opts: {
  session: PdfSession
  pageCount: number
  selectedPages: number[]
  apiKey: string
  baseUrl: string
  model: string
  getPageLabels: () => Promise<string[] | null>
  signal?: AbortSignal;
}): Promise<AiTocExtractionResult> {
  const { session, selectedPages, apiKey, baseUrl, model, getPageLabels, signal } = opts;

  const labels = await getPageLabels()

  const mock = (globalThis as any).__dshMockAiToc as ((request: { pages: number[]; phase: 'transcribe' | 'structure' }) => string | undefined) | undefined
  const isMock = typeof mock === 'function'

  if (!apiKey && !isMock) return { ok: false, error: 'AI 目录识别需要配置 API Key。' }

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

  // Window strategy: small TOC (<=8 pages) sent ONCE so the model sees full
  // cross-page continuity; larger TOC uses sequential windows of 8 pages. Each
  // window is only a TRANSCRIPTION batch, never a tree batch.
  const windowSize = selectedPages.length <= SMALL_TOC_MAX ? selectedPages.length : LARGE_TOC_WINDOW
  const windows: number[][] = []
  for (let i = 0; i < selectedPages.length; i += windowSize) windows.push(selectedPages.slice(i, i + windowSize));
  let allRows: TocTranscriptionRow[] = []
  let tail: TocTranscriptionRow[] = []
  for (let w = 0; w < windows.length; w++) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    const batch = windows[w];
    let transcription: TocTranscriptionRow[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) return { ok: false, error: '已取消' }
      try {
        const lines3 = await transcribeBatch({ batch, pageDataUrls, apiKey, baseUrl, model, tail, isMock, mock, signal });
        const mapped = mapTocSourcePages(lines3, batch);
        if (!mapped.ok) {
          const d = (mapped as { diagnostics: string[] }).diagnostics;
          throw new Error(d.length ? d[0] : '目录识别结果格式异常，请重试。');
        }
        transcription = mapped.rows;
        break;
      } catch (e) {
        if (signal?.aborted) return { ok: false, error: '已取消' }
        if (attempt === 0) { continue } // retry once
        return { ok: false, error: (e instanceof Error && e.message) ? e.message : '目录页面转录失败，请重试。' };
      }
    }
    if (!transcription) return { ok: false, error: '目录页面转录失败，请重试。' };
    allRows = allRows.concat(transcription);
    tail = transcription.slice(-PREV_TAIL_SIZE);
  }
  // Re-index to a stable contiguous r0001… (dedupe exact boundary copies first).
  allRows = reindexRows(allRows);
  if (allRows.length === 0) return { ok: false, error: '未识别到目录条目。' };

  // ---- GLOBAL structure pass: text-only, proposes {id, level} per row ----
  let structureRaw: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    try {
      if (isMock) { structureRaw = mock({ pages: [], phase: 'structure' }); }
      else {
        const seq = buildSequentialText(allRows);
        const messages: ApiChatMessage[] = [{ role: 'system', content: TOC_STRUCTURE_PROMPT }, { role: 'user', content: seq }];
        const res = await sendTextChat({ apiKey, baseUrl, model, messages, signal });
        structureRaw = res.content;
      }
      const sp = parseTocStructure(structureRaw || '');
      if (!sp.ok) throw new Error('结构格式异常');
      const sv = validateTocStructure(allRows, sp.proposals);
      if (!sv.ok) throw new Error('结构校验失败');
      const leveled = allRows.map((r, i) => ({ title: r.title, level: sv.levels[i], pageLabel: r.pageLabel, tocPage: r.tocPage }));
      const items = buildInitialMapping(leveled, labels);
      return { ok: true, items, labels, labelsPlainNumeric: labelsArePlainNumeric(labels) };
    } catch (e) {
      if (signal?.aborted) return { ok: false, error: '已取消' }
      if (attempt === 0) { continue } // retry once
      return { ok: false, error: '目录结构分析失败，请重试或进入手动编辑。' };
    }
  }
  return { ok: false, error: '目录结构分析失败，请重试或进入手动编辑。' };
}

async function transcribeBatch(opts: {
  batch: number[];
  pageDataUrls: Record<number, string>;
  apiKey: string; baseUrl: string; model: string;
  tail: TocTranscriptionRow[];
  isMock: boolean;
  mock: ((request: { pages: number[]; phase: 'transcribe' | 'structure' }) => string | undefined) | undefined;
  signal?: AbortSignal;
}): Promise<TocLocalRow[]> {
  const { batch, pageDataUrls, apiKey, baseUrl, model, tail, isMock, mock, signal } = opts;
  if (isMock) {
    const raw = mock!({ pages: batch, phase: 'transcribe' });
    if (typeof raw !== 'string') return [];
    const pr = parseTocJsonl(raw);
    if (!pr.ok) { const d = (pr as { diagnostics: string[] }).diagnostics; throw new Error(d.length ? d[0] : '目录识别结果格式异常，请重试。'); }
    // Mock rows use a pageBatch-appropriate sourceImageIndex; assign local ids.
    return pr.rows.map((r: TocTranscriptionLine, i: number) => ({ ...r, id: 'r' + String(i + 1).padStart(4, '0'), rowOrder: i }));
  }
  const parts: import('../api/deepseek').ChatContentPart[] = [];
  if (tail.length > 0) { parts.push({ type: 'text', text: buildTailContext(tail) } as const); }
  for (let k = 0; k < batch.length; k++) {
    const physicalPage = batch[k];
    parts.push({ type: 'text', text: '【图片 ' + (k + 1) + ' / ' + batch.length + ' · PDF physical page ' + physicalPage + '】' } as const);
    parts.push({ type: 'image_url', image_url: { url: pageDataUrls[physicalPage] } } as const);
  }
  const messages: ApiChatMessage[] = [{ role: 'system', content: TOC_TRANSCRIPTION_SYSTEM_PROMPT }, { role: 'user', content: parts }];
  const res = await sendTextChat({ apiKey, baseUrl, model, messages, signal });
  const pr = parseTocJsonl(res.content);
  if (!pr.ok) { const d = (pr as { diagnostics: string[] }).diagnostics; throw new Error(d.length ? d[0] : '目录识别结果格式异常，请重试。'); }
  return pr.rows.map((r: TocTranscriptionLine, i: number) => ({ ...r, id: 'r' + String(i + 1).padStart(4, '0'), rowOrder: i }));
}

export { TOC_TRANSCRIPTION_SYSTEM_PROMPT, TOC_STRUCTURE_PROMPT };