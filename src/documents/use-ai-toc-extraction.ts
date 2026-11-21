// Prepare OCR text, extract flat rows, then map the reviewed outline locally.
import { renderSessionThumbnail } from '../pdf/pdf-session'
import type { PdfSession } from '../pdf/pdf-session'
import { DeepSeekError, errorKindLabel, sendTextChat } from '../api/deepseek'
import { selectedDeepSeekServiceProfile } from '../engine/deepseek-service-profile'
import { mapTocBatches } from './toc-work-queue'
import { resolveCurrentProtocol } from '../prompts/prompt-resolution'
import { compileMachineProtocolMessages } from '../prompts/protocol-request'
import { ensurePageOcr } from './document-ocr'
import { recognizedOcrText } from '../api/deepseek-ocr'
import {
  assignLocalRowIds, inferFallbackTocLevels, mapTocSourcePages, parseTocJsonl,
  tocTranscriptionDiagnosticEnglish, validateTocPageLabelCoverage, validateTocStructure,
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
  | { ok: false; error: string; timing: AiTocTiming }

export type AiTocProgress =
  | { phase: 'rendering'; completed: number; total: number; currentPage?: number }
  | { phase: 'structuring' }
  | { phase: 'mapping' }
  | { phase: 'done' }

const AI_TOC_RENDER_EDGE = 1400
const AI_TOC_OCR_CONCURRENCY = 3
const AI_TOC_MAX_OUTPUT_TOKENS = 32768

/** A single model request after all selected OCR pages are ready. */
export async function extractAiToc(opts: {
  session: PdfSession
  documentId: string
  selectedPages: number[]
  getPageLabels: () => Promise<string[] | null>
  signal?: AbortSignal
  onProgress?: (progress: AiTocProgress) => void
}): Promise<AiTocExtractionResult> {
  const { session, documentId, getPageLabels, signal, onProgress } = opts
  const pages = [...new Set(opts.selectedPages)].sort((a, b) => a - b)
  const started = aiTocNowMs()
  const timing = createAiTocTiming()
  const finish = <T extends { ok: boolean }>(result: T) => ({ ...result, timing: finalizeAiTocTiming(timing, started) })
  const mock = (globalThis as unknown as {
    __dshMockAiToc?: (request: { pages: number[]; phase: 'outline' }) => string
  }).__dshMockAiToc
  const apiKey = selectedDeepSeekServiceProfile()?.config.apiKey.trim() ?? ''
  if (!apiKey && !mock) {
    return finish({ ok: false, error: tx('AI 目录识别需要在 API 配置中保存 DeepSeek 官方 Key。', 'Save an official DeepSeek API key in Settings to detect the outline.') })
  }
  if (!pages.length) return finish({ ok: false, error: tx('请至少选择一页目录。', 'Select at least one outline page.') })

  const [protocol, labels] = await Promise.all([
    resolveCurrentProtocol('ai-toc-transcription', started),
    getPageLabels(),
  ])
  let completed = 0
  const ocrStarted = aiTocNowMs()
  let ocrInput: { sourceImageIndex: number; text: string }[]
  onProgress?.({ phase: 'rendering', completed, total: pages.length })
  try {
    ocrInput = await mapTocBatches(pages, AI_TOC_OCR_CONCURRENCY, async (page, index, workSignal) => {
      let text = ''
      if (!mock) {
        try {
          const ocr = await ensurePageOcr(documentId, page,
            async () => (await renderSessionThumbnail(session, page, AI_TOC_RENDER_EDGE, workSignal)).blob,
            cached => cached.finishReason === 'stop' && !!recognizedOcrText(cached))
          text = recognizedOcrText(ocr)
          if (ocr.finishReason === 'length') throw new Error(tx('OCR 文本被截断。', 'OCR text was truncated.'))
          if (!text) throw new Error(tx('OCR 未识别到文字。', 'OCR found no text.'))
        } catch (error) {
          const detail = error instanceof Error ? error.message : tx('请重试。', 'Try again.')
          throw new Error(tx('第 ' + page + ' 页 OCR 失败：', 'PDF page ' + page + ' OCR failed: ') + detail)
        }
      }
      if (!workSignal.aborted) onProgress?.({ phase: 'rendering', completed: ++completed, total: pages.length, currentPage: page })
      return { sourceImageIndex: index + 1, text }
    }, signal)
  } catch (error) {
    return finish({ ok: false, error: signal?.aborted ? tx('已取消', 'Cancelled') : error instanceof Error ? error.message : tx('目录 OCR 失败。', 'Outline OCR failed.') })
  } finally {
    timing.renderingMs = elapsedAiTocMs(ocrStarted)
  }

  if (signal?.aborted) return finish({ ok: false, error: tx('已取消', 'Cancelled') })
  onProgress?.({ phase: 'structuring' })
  const modelStarted = aiTocNowMs()
  let raw: string
  let truncated = false
  try {
    if (mock) raw = mock({ pages, phase: 'outline' })
    else {
      const content = 'Process all the OCR pages together. Return one compact JSON object {"rows":[{"title":"Chapter 1","pageLabel":"1","sourceImageIndex":1,"level":1}]}. The level is required for every row. Preserve all outline entries in order. Use no pretty-printing, prose, or fields beyond the outline schema.\n' + JSON.stringify(ocrInput)
      const messages = await compileMachineProtocolMessages({ domain: 'ai-toc-transcription', protocol, content })
      const reply = await sendTextChat({ apiKey, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
        messages, signal, thinking: 'disabled', jsonObject: true, maxTokens: AI_TOC_MAX_OUTPUT_TOKENS })
      truncated = reply.finishReason === 'length'
      raw = reply.content
    }
  } catch (error) {
    return finish({ ok: false, error: signal?.aborted ? tx('已取消', 'Cancelled') :
      error instanceof DeepSeekError ? errorKindLabel(error.kind) : tx('目录识别失败，请重试。', 'Outline detection failed. Try again.') })
  } finally {
    timing.transcriptionMs.push(elapsedAiTocMs(modelStarted))
  }

  if (signal?.aborted) return finish({ ok: false, error: tx('已取消', 'Cancelled') })
  if (truncated) {
    return finish({ ok: false, error: tx('目录输出被截断（达到模型输出长度限制）。可减少所选页后手动重试。', 'The outline output was truncated at the model output-token limit. Select fewer pages and try again.') })
  }
  const invalid = (detail: string) => finish({ ok: false, error: tx('目录格式不正确：' + detail, 'Invalid outline format: ' + tocTranscriptionDiagnosticEnglish(detail)) })
  const parsed = parseTocJsonl(raw, { defaultSourceImageIndex: pages.length === 1 ? 1 : undefined })
  if (parsed.ok === false) return invalid(parsed.diagnostics[0])
  const mapped = mapTocSourcePages(assignLocalRowIds(parsed.rows), pages)
  if (mapped.ok === false) return invalid(mapped.diagnostics[0])

  const labelsCheck = validateTocPageLabelCoverage(mapped.rows)
  if (labelsCheck.ok === false) return invalid(labelsCheck.diagnostics[0])
  const levels = validateTocStructure(mapped.rows, parsed.rows.map(row => row.level ?? 0))
  const hierarchy = levels.ok ? levels.levels : inferFallbackTocLevels(mapped.rows)
  onProgress?.({ phase: 'mapping' })
  const mappingStarted = aiTocNowMs()
  const items = buildInitialMapping(mapped.rows.map(({ title, pageLabel, tocPage }, index) => ({ title, pageLabel, tocPage, level: hierarchy[index] })), labels, session.documentProxy.numPages)
  timing.mappingMs = elapsedAiTocMs(mappingStarted)
  onProgress?.({ phase: 'done' })
  return finish({ ok: true, items, labels, labelsPlainNumeric: labelsArePlainNumeric(labels),
    warning: levels.ok ? undefined : tx('模型返回的层级未通过校验，已生成可编辑草稿。请检查层级后再保存。', 'The model hierarchy failed validation. Review the hierarchy in the editable draft before saving.') })
}
