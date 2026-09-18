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
import { renderSessionThumbnail } from '../pdf/pdf-session'
import type { PdfSession } from '../pdf/pdf-session'
import { DeepSeekError, errorKindLabel, isVisionModel, sendTextChat, type ErrorKind, type VisionCapability } from '../api/deepseek'
import { resolveCurrentProtocol } from '../prompts/prompt-resolution'
import { compileMachineProtocolMessages } from '../prompts/protocol-request'
import type { StableId } from '../engine/types'
import type { ProtocolPromptSnapshot } from '../prompts/prompt-types'
import {
  parseTocJsonl, parseTocStructure, validateTocStructure,
  mapTocSourcePages, reindexRows, dedupeWindowBoundary,
  TOC_TRANSCRIPTION_SYSTEM_PROMPT, TOC_STRUCTURE_PROMPT, buildTocStructureRepairPrompt, buildTocTranscriptionRepairPrompt,
  buildTocStructureInput,
  inferFallbackTocLevels, tocTranscriptionDiagnosticEnglish, validateTocPageLabelCoverage,
  type TocTranscriptionRow, type TocLocalRow, type TocTranscriptionLine,
  type TocStructureDiagnostic,
} from './ai-toc'
import { tx } from '../engine/locale'
import { buildInitialMapping, labelsArePlainNumeric, type MappedTocItem } from './toc-mapping'
import {
  aiTocNowMs, elapsedAiTocMs, finalizeAiTocTiming, createAiTocTiming,
  type AiTocTiming,
} from './ai-toc-timing'

export type { AiTocTiming } from './ai-toc-timing'

export type AiTocExtractionResult =
  | { ok: true; items: MappedTocItem[]; labels: string[] | null; labelsPlainNumeric: boolean; warning?: string; timing: AiTocTiming }
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
const AI_TOC_RENDER_EDGE = 1400
const AI_TOC_RENDER_CONCURRENCY = 3

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
  return 'Previous-batch tail rows, provided only for cross-page continuity:\n' + lines2 + '\nTranscribe only new rows in the current images. Do not repeat the tail rows.';
}

class TocTranscriptionValidationError extends Error {
  readonly diagnostics: string[]
  constructor(diagnostics: string[]) {
    super(diagnostics[0] || '目录识别结果格式异常')
    this.name = 'TocTranscriptionValidationError'
    this.diagnostics = diagnostics
  }
}

function transcriptionFailureMessage(error: unknown): string {
  if (error instanceof DeepSeekError) return errorKindLabel(error.kind)
  if (error instanceof TocTranscriptionValidationError) {
    const zh = error.diagnostics[0] || '目录识别结果格式异常'
    const en = tocTranscriptionDiagnosticEnglish(zh)
    return tx('模型返回的目录格式不正确：' + zh + '。已根据该错误自动修复并重试，但仍未通过。', 'The model returned an invalid outline format: ' + en + ' An automatic corrective retry also failed.')
  }
  return tx('目录页面转录失败，请重试。', 'Outline-page transcription failed. Try again.')
}

function transportRetryPrompt(kind: ErrorKind): string {
  const reasons: Record<ErrorKind, string> = {
    'no-api-key': 'the API key was unavailable',
    'network-or-cors': 'the network request or CORS check failed',
    unauthorized: 'the API rejected authentication',
    billing: 'the API reported a billing or balance problem',
    'rate-limited': 'the API rate-limited the request',
    'bad-request': 'the API rejected the request parameters or payload',
    server: 'the API returned a server error',
    'bad-json': 'the API response was not valid JSON',
    'no-content': 'the model returned no usable content',
    aborted: 'the request was cancelled',
  }
  return 'The previous attempt failed because ' + reasons[kind] + '. Retry the same images and follow the JSONL schema exactly. Every row must include title, pageLabel, and sourceImageIndex. Use pageLabel:"" when no printed destination-page label is visible.'
}

function transcriptionRetryPrompt(error: unknown): string {
  if (error instanceof TocTranscriptionValidationError) return buildTocTranscriptionRepairPrompt(error.diagnostics)
  if (error instanceof DeepSeekError) return transportRetryPrompt(error.kind)
  return buildTocTranscriptionRepairPrompt([])
}

function canSplitFailedBatch(error: unknown): boolean {
  return error instanceof TocTranscriptionValidationError
    || (error instanceof DeepSeekError && (error.kind === 'bad-request' || error.kind === 'bad-json' || error.kind === 'no-content'))
}

function isNonRetryableTransportFailure(error: unknown): boolean {
  return error instanceof DeepSeekError
    && (error.kind === 'no-api-key' || error.kind === 'unauthorized' || error.kind === 'billing' || error.kind === 'aborted')
}

type TranscribeMappedBatchOptions = {
  batch: number[]
  pageDataUrls: Record<number, string>
  apiKey: string
  baseUrl: string
  model: string
  tail: TocTranscriptionRow[]
  protocol: ProtocolPromptSnapshot
  isMock: boolean
  mock: ((request: AiTocMockRequest) => string | undefined) | undefined
  signal?: AbortSignal
  /** Bound adaptive recovery to one split so a bad provider response cannot fan
   * out into dozens of slow, paid requests for a large selected range. */
  splitDepth?: number
}

/** Two schema-aware attempts, followed by an adaptive split for failures that a
 * smaller vision payload can repair. Transport failures such as auth/rate limits
 * remain bounded to two attempts and are never multiplied by recursive splitting. */
async function transcribeMappedBatchResilient(opts: TranscribeMappedBatchOptions): Promise<TocTranscriptionRow[]> {
  let lastError: unknown = new TocTranscriptionValidationError(['未识别到目录条目'])
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.signal?.aborted) throw new DeepSeekError('aborted', 'request aborted')
    try {
      const rows = await transcribeBatch({ ...opts, repairPrompt: attempt === 1 ? transcriptionRetryPrompt(lastError) : '' })
      const mapped = mapTocSourcePages(rows, opts.batch)
      if (!mapped.ok) throw new TocTranscriptionValidationError((mapped as { diagnostics: string[] }).diagnostics)
      const coverage = validateTocPageLabelCoverage(mapped.rows)
      if (coverage.ok === false) throw new TocTranscriptionValidationError(coverage.diagnostics)
      return mapped.rows
    } catch (error) {
      lastError = error
      if (isNonRetryableTransportFailure(error)) break
    }
  }

  const splitDepth = opts.splitDepth ?? 0
  if (opts.batch.length > 1 && splitDepth < 1 && canSplitFailedBatch(lastError)) {
    const midpoint = Math.ceil(opts.batch.length / 2)
    const leftBatch = opts.batch.slice(0, midpoint)
    const rightBatch = opts.batch.slice(midpoint)
    const left = await transcribeMappedBatchResilient({ ...opts, batch: leftBatch, splitDepth: splitDepth + 1 })
    const nextTail = opts.tail.concat(left).slice(-PREV_TAIL_SIZE)
    const right = await transcribeMappedBatchResilient({ ...opts, batch: rightBatch, tail: nextTail, splitDepth: splitDepth + 1 })
    return left.concat(dedupeWindowBoundary(left, right))
  }

  throw lastError
}

/**
 * Run the flat transcription -> global structure pipeline for one document.
 * `signal` is an AbortSignal: when aborted, no further request is started and
 * the result is { ok:false, error:'已取消' } (never a network-or-cors mislabel).
 * Retry contract: a malformed/schema-invalid transcription is retried once;
 * structure validation gets one diagnostic repair attempt. If hierarchy still
 * fails, the faithful transcription opens as a locally structured review draft.
 */
export async function extractAiToc(opts: {
  session: PdfSession
  pageCount: number
  selectedPages: number[]
  apiKey: string
  baseUrl: string
  model: string
  visionCapability?: VisionCapability
  getPageLabels: () => Promise<string[] | null>
  signal?: AbortSignal;
  /** Real phase progress at stage boundaries (never guessed from a timeout). */
  onProgress?: (p: AiTocProgress) => void
}): Promise<AiTocExtractionResult> {
  const { session, selectedPages, apiKey, baseUrl, model, visionCapability, getPageLabels, signal, onProgress } = opts;
  const totalStartMs = aiTocNowMs()
  const timing = createAiTocTiming()

  // Freeze both machine protocols before rendering or making the first model
  // request. Every window and retry reuses these detached snapshots.
  const [transcriptionProtocol, structureProtocol, labels] = await Promise.all([
    resolveCurrentProtocol('ai-toc-transcription', totalStartMs),
    resolveCurrentProtocol('ai-toc-structure', totalStartMs),
    getPageLabels(),
  ])

  const mock = (globalThis as any).__dshMockAiToc as ((request: AiTocMockRequest) => string | undefined) | undefined
  const isMock = typeof mock === 'function'

  if (!apiKey && !isMock) return timedAiTocResult({ ok: false, error: 'AI 目录识别需要配置 API Key。' }, timing, totalStartMs)
  if (!isMock && !isVisionModel(model, visionCapability)) {
    return timedAiTocResult({ ok: false, error: '当前模型未配置为支持图片。请在设置中选择支持视觉输入的模型，或将视觉能力设为“支持图片”。' }, timing, totalStartMs)
  }
  if (selectedPages.length === 0) return timedAiTocResult({ ok: false, error: '请至少选择一页目录。' }, timing, totalStartMs)

  // Window strategy: small TOC (<=8 pages) sent ONCE so the model sees full
  // cross-page continuity; larger TOC uses sequential windows of 8 pages. Each
  // window is rendered, transcribed, and released before the next one. This
  // avoids retaining a base64 copy of every selected page and starts the model
  // request as soon as the first window is ready.
  const windowSize = selectedPages.length <= SMALL_TOC_MAX ? selectedPages.length : LARGE_TOC_WINDOW
  const windows: number[][] = []
  for (let i = 0; i < selectedPages.length; i += windowSize) windows.push(selectedPages.slice(i, i + windowSize));
  let renderCompleted = 0
  let allRows: TocTranscriptionRow[] = []
  let tail: TocTranscriptionRow[] = []
  for (let w = 0; w < windows.length; w++) {
    const batch = windows[w];
    if (signal?.aborted) return abortedAiTocResult('rendering', timing, totalStartMs)

    const pageDataUrls: Record<number, string> = {}
    const renderingStartMs = aiTocNowMs()
    let renderCursor = 0
    let renderFailure: number | null = null
    const renderWorker = async () => {
      while (renderCursor < batch.length && renderFailure == null && !signal?.aborted) {
        const n = batch[renderCursor++]
        onProgress?.({ phase: 'rendering', completed: renderCompleted, total: selectedPages.length, currentPage: n })
        try {
          const rendered = await renderSessionThumbnail(session, n, AI_TOC_RENDER_EDGE)
          const url = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(new Error('render'))
            reader.readAsDataURL(rendered.blob)
          })
          if (signal?.aborted) return
          pageDataUrls[n] = url
          renderCompleted++
          onProgress?.({ phase: 'rendering', completed: renderCompleted, total: selectedPages.length, currentPage: n })
        } catch { renderFailure = n }
      }
    }
    await Promise.all(Array.from({ length: Math.min(AI_TOC_RENDER_CONCURRENCY, batch.length) }, () => renderWorker()))
    timing.renderingMs += elapsedAiTocMs(renderingStartMs)
    if (signal?.aborted) return abortedAiTocResult('rendering', timing, totalStartMs)
    if (renderFailure != null) return timedAiTocResult({ ok: false, error: '第 ' + renderFailure + ' 页渲染失败，无法用于目录识别。' }, timing, totalStartMs)

    const transcriptionStartMs = aiTocNowMs()
    let transcriptionTimingRecorded = false
    const finishTranscription = () => {
      if (!transcriptionTimingRecorded) {
        timing.transcriptionMs.push(elapsedAiTocMs(transcriptionStartMs))
        transcriptionTimingRecorded = true
      }
    }
    onProgress?.({ phase: 'transcribing', windowIndex: w, windowCount: windows.length })
    let transcription: TocTranscriptionRow[]
    try {
      transcription = await transcribeMappedBatchResilient({ batch, pageDataUrls, apiKey, baseUrl, model, tail, protocol: transcriptionProtocol, isMock, mock, signal })
    } catch (error) {
      if (signal?.aborted || (error instanceof DeepSeekError && error.kind === 'aborted')) {
        finishTranscription()
        return abortedAiTocResult('transcribing', timing, totalStartMs)
      }
      finishTranscription()
      return timedAiTocResult({ ok: false, error: transcriptionFailureMessage(error) }, timing, totalStartMs)
    }
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
        const messages = await compileMachineProtocolMessages({ domain: 'ai-toc-structure', protocol: structureProtocol, content: userContent })
        const res = await sendTextChat({ apiKey, baseUrl, model, messages, signal, reasoningEffort: 'low' });
        structureRaw = res.content;
      }
      const sp = parseTocStructure(structureRaw || '');
      if (sp.ok === false) {
        finishStructureAttempt()
        lastStructureDiagnostics = sp.diagnostics
        continue
      }
      const sv = validateTocStructure(allRows, sp.levels);
      if (!sv.ok) {
        finishStructureAttempt()
        lastStructureDiagnostics = sv.diagnostics
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
    }
  }
  // Transcription is the expensive, provenance-sensitive part. Do not discard it
  // merely because the optional hierarchy response was malformed twice: open the
  // normal human review with a conservative deterministic hierarchy instead.
  onProgress?.({ phase: 'mapping' })
  const mappingStartMs = aiTocNowMs()
  const fallbackLevels = inferFallbackTocLevels(allRows)
  const fallbackRows = allRows.map((r, i) => ({ title: r.title, level: fallbackLevels[i], pageLabel: r.pageLabel, tocPage: r.tocPage }))
  const items = buildInitialMapping(fallbackRows, labels)
  timing.mappingMs = elapsedAiTocMs(mappingStartMs)
  onProgress?.({ phase: 'done' })
  return timedAiTocResult({
    ok: true,
    items,
    labels,
    labelsPlainNumeric: labelsArePlainNumeric(labels),
    warning: 'AI 已完成目录文字识别，但层级分析未通过校验。已生成可编辑草稿，请重点检查层级后再保存。',
  }, timing, totalStartMs)
}

async function transcribeBatch(opts: {
  batch: number[];
  pageDataUrls: Record<number, string>;
  apiKey: string; baseUrl: string; model: string;
  tail: TocTranscriptionRow[];
  protocol: ProtocolPromptSnapshot;
  repairPrompt: string;
  isMock: boolean;
  mock: ((request: AiTocMockRequest) => string | undefined) | undefined;
  signal?: AbortSignal;
}): Promise<TocLocalRow[]> {
  const { batch, pageDataUrls, apiKey, baseUrl, model, tail, protocol, repairPrompt, isMock, mock, signal } = opts;
  if (isMock) {
    const raw = mock!({ pages: batch, phase: 'transcribe' });
    if (typeof raw !== 'string') return [];
    const pr = parseTocJsonl(raw, batch.length === 1 ? { defaultSourceImageIndex: 1 } : {});
    if (!pr.ok) throw new TocTranscriptionValidationError((pr as { diagnostics: string[] }).diagnostics)
    // Mock rows use a pageBatch-appropriate sourceImageIndex; assign local ids.
    return pr.rows.map((r: TocTranscriptionLine, i: number) => ({ ...r, id: 'r' + String(i + 1).padStart(4, '0'), rowOrder: i }));
  }
  const contentLines: string[] = []
  if (tail.length > 0) contentLines.push(buildTailContext(tail))
  if (repairPrompt) contentLines.push(repairPrompt)
  const images: { id: StableId; dataUrl: string }[] = []
  for (let k = 0; k < batch.length; k++) {
    const physicalPage = batch[k];
    contentLines.push('【图片 ' + (k + 1) + ' / ' + batch.length + ' · PDF physical page ' + physicalPage + '】')
    images.push({ id: 'ai-toc-page-' + physicalPage + '-' + k, dataUrl: pageDataUrls[physicalPage] })
  }
  const messages = await compileMachineProtocolMessages({ domain: 'ai-toc-transcription', protocol, content: contentLines.join('\n'), images })
  const res = await sendTextChat({ apiKey, baseUrl, model, messages, signal, reasoningEffort: 'low' });
  const pr = parseTocJsonl(res.content, batch.length === 1 ? { defaultSourceImageIndex: 1 } : {});
  if (!pr.ok) throw new TocTranscriptionValidationError((pr as { diagnostics: string[] }).diagnostics)
  return pr.rows.map((r: TocTranscriptionLine, i: number) => ({ ...r, id: 'r' + String(i + 1).padStart(4, '0'), rowOrder: i }));
}

export { TOC_TRANSCRIPTION_SYSTEM_PROMPT, TOC_STRUCTURE_PROMPT };
