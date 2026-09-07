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
  mapTocSourcePages, reindexRows, dedupeWindowBoundary,
  TOC_TRANSCRIPTION_SYSTEM_PROMPT, TOC_STRUCTURE_PROMPT, describeTocStructureFailure, buildTocStructureRepairPrompt,
  buildTocStructureInput,
  type TocTranscriptionRow, type TocLocalRow, type TocTranscriptionLine,
  type TocStructureDiagnostic,
} from './ai-toc'
import { buildInitialMapping, labelsArePlainNumeric, type MappedTocItem } from './toc-mapping'
import {
  aiTocNowMs, elapsedAiTocMs, finalizeAiTocTiming, createAiTocTiming,
  type AiTocTiming,
} from './ai-toc-timing'

export type { AiTocTiming } from './ai-toc-timing'

export type AiTocExtractionResult =
  | { ok: true; items: MappedTocItem[]; labels: string[] | null; labelsPlainNumeric: boolean; timing: AiTocTiming }
  | { ok: false; error: string; diagnostics?: AiTocFailureDiagnostics; timing: AiTocTiming }

/** Developer-facing, non-sensitive runtime diagnostics. The UI uses `error`,
 * while callers/tests can inspect the reason, attempt, and row counts without
 * logging prompts, PDF contents, or API failures. */
export type AiTocFailureDiagnostics = {
  stage: 'rendering' | 'transcribing' | 'structuring'
  attempt?: number
  diagnostics: TocStructureDiagnostic[]
}

// Finding 9.4D.2-0.6.8: real, phase-based progress reported by the orchestrator at actual
// stage boundaries (never guessed from a timeout). The UI renders this verbatim.
export type AiTocProgress =
  | { phase: 'rendering'; completed: number; total: number; currentPage?: number }
  | { phase: 'transcribing'; windowIndex: number; windowCount: number }
  | { phase: 'structuring'; repair?: boolean }
  | { phase: 'mapping' }
  | { phase: 'done' }



// ---- previous-tail continuity context (Stage 9.4C.1) ----
const PREV_TAIL_SIZE = 4
const LARGE_TOC_WINDOW = 8
const SMALL_TOC_MAX = 8

type AiTocMockRequest = {
  pages: number[]
  phase: 'transcribe' | 'structure'
  attempt?: number
  repair?: boolean
  diagnostics?: TocStructureDiagnostic[]
}

function timedAiTocResult<T extends { ok: boolean }>(result: T, timing: AiTocTiming, totalStartMs: number): T & { timing: AiTocTiming } {
  return { ...result, timing: finalizeAiTocTiming(timing, totalStartMs) }
}

function abortedAiTocResult(stage: AiTocFailureDiagnostics['stage'], timing: AiTocTiming, totalStartMs: number): AiTocExtractionResult {
  return timedAiTocResult({ ok: false, error: '已取消', diagnostics: { stage, diagnostics: [{ code: 'ABORTED', message: '用户取消目录识别' }] } }, timing, totalStartMs)
}

function buildTailContext(prevRows: TocTranscriptionRow[]): string {
  if (prevRows.length === 0) return ''
  const tail = prevRows.slice(-PREV_TAIL_SIZE)
  const lines2 = tail.map(r => r.id + ' | ' + r.title + ' | p' + r.pageLabel).join('\n')
  return '上一批最后几条目录转录，仅用于理解跨页连续性：\n' + lines2 + '\n请只转录当前图片中新出现的目录行。不要重新输出以上内容。';
}

/**
 * Run the flat transcription -> global structure pipeline for one document.
 * `signal` is an AbortSignal: when aborted, no further request is started and
 * the result is { ok:false, error:'已取消' } (never a network-or-cors mislabel).
 * Retry contract: a malformed/schema-invalid transcription is retried once;
 * structure validation gets one diagnostic repair attempt, then aborts without
 * returning a partial draft.
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
  /** Real phase progress at stage boundaries (never guessed from a timeout). */
  onProgress?: (p: AiTocProgress) => void
}): Promise<AiTocExtractionResult> {
  const { session, selectedPages, apiKey, baseUrl, model, getPageLabels, signal, onProgress } = opts;
  const totalStartMs = aiTocNowMs()
  const timing = createAiTocTiming()

  const labels = await getPageLabels()

  const mock = (globalThis as any).__dshMockAiToc as ((request: AiTocMockRequest) => string | undefined) | undefined
  const isMock = typeof mock === 'function'

  if (!apiKey && !isMock) return timedAiTocResult({ ok: false, error: 'AI 目录识别需要配置 API Key。' }, timing, totalStartMs)

  // Render each selected TOC page to a small data URL (never persisted).
  const pageDataUrls: Record<number, string> = {}
  const renderingStartMs = aiTocNowMs()
  const finishRendering = () => { timing.renderingMs = elapsedAiTocMs(renderingStartMs) }
  for (let ri = 0; ri < selectedPages.length; ri++) {
    const n = selectedPages[ri]
    if (signal?.aborted) { finishRendering(); return abortedAiTocResult('rendering', timing, totalStartMs) }
    onProgress?.({ phase: 'rendering', completed: ri, total: selectedPages.length, currentPage: n })
    try {
      const r = await renderSessionPage(session, n)
      const url = await new Promise<string>((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject('render'); fr.readAsDataURL(r.blob) })
      pageDataUrls[n] = url
    } catch { finishRendering(); return timedAiTocResult({ ok: false, error: '第 ' + n + ' 页渲染失败，无法用于目录识别。' }, timing, totalStartMs) }
  }
  finishRendering()

  // Window strategy: small TOC (<=8 pages) sent ONCE so the model sees full
  // cross-page continuity; larger TOC uses sequential windows of 8 pages. Each
  // window is only a TRANSCRIPTION batch, never a tree batch.
  const windowSize = selectedPages.length <= SMALL_TOC_MAX ? selectedPages.length : LARGE_TOC_WINDOW
  const windows: number[][] = []
  for (let i = 0; i < selectedPages.length; i += windowSize) windows.push(selectedPages.slice(i, i + windowSize));
  let allRows: TocTranscriptionRow[] = []
  let tail: TocTranscriptionRow[] = []
  for (let w = 0; w < windows.length; w++) {
    if (signal?.aborted) return abortedAiTocResult('transcribing', timing, totalStartMs)
    const batch = windows[w];
    const transcriptionStartMs = aiTocNowMs()
    let transcriptionTimingRecorded = false
    const finishTranscription = () => {
      if (!transcriptionTimingRecorded) {
        timing.transcriptionMs.push(elapsedAiTocMs(transcriptionStartMs))
        transcriptionTimingRecorded = true
      }
    }
    onProgress?.({ phase: 'transcribing', windowIndex: w, windowCount: windows.length })
    let transcription: TocTranscriptionRow[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) { finishTranscription(); return abortedAiTocResult('transcribing', timing, totalStartMs) }
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
        if (signal?.aborted) { finishTranscription(); return abortedAiTocResult('transcribing', timing, totalStartMs) }
        if (attempt === 0) { continue } // retry once
        finishTranscription()
        return timedAiTocResult({ ok: false, error: (e instanceof Error && e.message) ? e.message : '目录页面转录失败，请重试。' }, timing, totalStartMs)
      }
    }
    if (!transcription) { finishTranscription(); return timedAiTocResult({ ok: false, error: '目录页面转录失败，请重试。' }, timing, totalStartMs) }
    finishTranscription()
    // Boundary-only dedupe: drop the head rows of this window that EXACTLY duplicate the tail
    // of the accumulated rows (a previous-window continuity hint re-output) — NEVER dedupes
    // two identical rows within the same window, and NEVER fuzzy-merges.
    const deduped = dedupeWindowBoundary(allRows, transcription);
    allRows = allRows.concat(deduped);
    tail = transcription.slice(-PREV_TAIL_SIZE);
  }
  // Re-index to a stable contiguous r0001… (dedupe exact boundary copies first).
  allRows = reindexRows(allRows);
  if (allRows.length === 0) return timedAiTocResult({ ok: false, error: '未识别到目录条目。' }, timing, totalStartMs)

  // ---- GLOBAL structure pass: text-only, proposes one compact level sequence ----
  // This input is immutable across the optional repair attempt. Serialize it
  // once so a repair only adds diagnostics instead of rebuilding every row.
  const structureInput = buildTocStructureInput(allRows)
  let structureRaw: string | undefined
  let lastStructureDiagnostics: TocStructureDiagnostic[] = []
  let lastStructureAttempt = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return abortedAiTocResult('structuring', timing, totalStartMs)
    onProgress?.({ phase: 'structuring', repair: attempt === 1 })
    const structureStartMs = aiTocNowMs()
    let structureTimingRecorded = false
    const finishStructureAttempt = () => {
      if (!structureTimingRecorded) {
        timing.structureAttemptMs.push(elapsedAiTocMs(structureStartMs))
        structureTimingRecorded = true
      }
    }
    try {
      const repair = attempt === 1
      const repairPrompt = repair ? buildTocStructureRepairPrompt(allRows.length, lastStructureDiagnostics) : ''
      if (isMock) {
        structureRaw = mock({ pages: [], phase: 'structure', attempt: attempt + 1, repair, diagnostics: repair ? lastStructureDiagnostics : [] });
      }
      else {
        const userContent = repair ? structureInput + '\n\n' + repairPrompt : structureInput
        const messages: ApiChatMessage[] = [{ role: 'system', content: TOC_STRUCTURE_PROMPT }, { role: 'user', content: userContent }];
        const res = await sendTextChat({ apiKey, baseUrl, model, messages, signal });
        structureRaw = res.content;
      }
      const sp = parseTocStructure(structureRaw || '');
      if (sp.ok === false) {
        finishStructureAttempt()
        lastStructureDiagnostics = sp.diagnostics
        lastStructureAttempt = attempt + 1
        continue
      }
      const sv = validateTocStructure(allRows, sp.levels);
      if (!sv.ok) {
        finishStructureAttempt()
        lastStructureDiagnostics = sv.diagnostics
        lastStructureAttempt = attempt + 1
        continue
      }
      const leveled = allRows.map((r, i) => ({ title: r.title, level: sv.levels[i], pageLabel: r.pageLabel, tocPage: r.tocPage }));
      finishStructureAttempt()
      onProgress?.({ phase: 'mapping' })
      const mappingStartMs = aiTocNowMs()
      const items = buildInitialMapping(leveled, labels);
      timing.mappingMs = elapsedAiTocMs(mappingStartMs)
      onProgress?.({ phase: 'done' })
      return timedAiTocResult({ ok: true, items, labels, labelsPlainNumeric: labelsArePlainNumeric(labels) }, timing, totalStartMs)
    } catch (e) {
      finishStructureAttempt()
      if (signal?.aborted) return abortedAiTocResult('structuring', timing, totalStartMs)
      // Keep raw transport/provider errors out of the UI and console: they can
      // contain endpoint or provider details. The stable code remains actionable.
      lastStructureDiagnostics = [{ code: 'API_ERROR', message: '结构分析请求失败' }]
      lastStructureAttempt = attempt + 1
    }
  }
  return timedAiTocResult({
    ok: false,
    error: describeTocStructureFailure(lastStructureDiagnostics),
    diagnostics: { stage: 'structuring' as const, attempt: lastStructureAttempt, diagnostics: lastStructureDiagnostics },
  }, timing, totalStartMs)
}

async function transcribeBatch(opts: {
  batch: number[];
  pageDataUrls: Record<number, string>;
  apiKey: string; baseUrl: string; model: string;
  tail: TocTranscriptionRow[];
  isMock: boolean;
  mock: ((request: AiTocMockRequest) => string | undefined) | undefined;
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
