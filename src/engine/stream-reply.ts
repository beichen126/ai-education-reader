import { buildOcrAwareContext } from './ocr-context'
import {resolveCurrentProtocol} from '../prompts/prompt-resolution'
import {appendGenUiGuidance} from '../prompts/prompt-compile-strategies'
import { nativeConversationOptions, citationFooter } from '../api/deepseek-native'
import { validateDocumentContext } from '../api/deepseek-documents'
import { newStableId, type Message, type StableId } from './types'
import type { Settings } from './settings-store'
import { buildContextMessages, buildApiMessages, countImageParts, isVisionModel, DeepSeekError, errorKindLabel } from '../api/deepseek'
import { toModelAttachment as toDataUrl, getAttachment, AttachmentError, attachmentErrorLabel } from './attachment-service'
import { generationRegistry, type GenerationLease } from './generation-registry'
import { projectLogicalPromptContext } from '../prompts/prompt-compile-strategies'
import type { AcceptedSendContext } from '../prompts/prompt-send'
import type { SendFailure, SendOutcome } from './send-outcome'
import { prepareWebResearch, WebResearchError } from '../api/deepseek-web'
import { hasFirecrawlWebSearch, isWebSearchEnabled, prepareFirecrawlResearch } from '../api/firecrawl-web'
import { streamProviderChat } from '../api/chat-provider'
import { getLocalStatus, LocalProviderError } from '../api/openai-local'
import { DeepSeekFilesError } from '../api/deepseek-files'
import { getToolQueries, searchQuery } from '../api/web-search-tool'
import { tx } from './locale'

/**
 * Thread-agnostic streaming reply engine. ONE generation pipeline is shared by the ROOT
 * conversation and every BRANCH. The target abstracts only the durable/rendering target:
 * context, placeholder placement, in-memory content update, ordered durable checkpoints,
 * status, and deletion guard. This is the single source of the stream/checkpoint/abort/
 * stale-write rules so root and branch behavior cannot drift.
 */
export type ReplyMetadata = Pick<Message, 'serverToolCalls' | 'annotations' | 'reasoning'>

export interface ReplyThread {
  acceptTitle?(title: string): void
  readonly genKey: string
  getContextMessages(): Message[] | Promise<Message[]>
  createAssistantPlaceholder(assistantId: StableId, now: number): void
  updateAssistantContent(content: string, usage?: import('./token-usage').TokenUsage, metadata?: ReplyMetadata): void
  persistCheckpoint?(content: string): void
  persistFinal(): Promise<void>
  drainWrites(): Promise<void>
  exists(): boolean | Promise<boolean>
  setStreaming(): void
  setIdle(): void
  settleAssistant(status: 'failed' | 'aborted', message: string): void
  setError(error: SendFailure): void
}

export const STREAM_RENDER_INTERVAL_MS = 200
const DURABLE_CHECKPOINT_MS = 1500

/**
 * Run ONE assistant reply through a thread-agnostic pipeline.
 * Order: local preflight (no placeholder yet) -> placeholder -> SSE stream with throttled
 * render + ordered durable checkpoints -> final flush -> drain -> cleanup. A preflight
 * failure never leaves a ghost placeholder. Deletion during generation, abort and error all
 * settle deterministically.
 */
export async function runThreadReply(thread: ReplyThread, settings: Settings, controller: AbortController, onStreamStart?: (controller: AbortController, assistantId: StableId) => void, acceptedSendContext?: AcceptedSendContext, lease?: GenerationLease): Promise<SendOutcome> {
  const ownedLease = lease ?? generationRegistry.acquire(thread.genKey, controller, 'sending')
  if (!ownedLease || ownedLease.key !== thread.genKey || ownedLease.controller !== controller) {
    return { kind: 'rejected', code: 'generation-busy', message: '当前已有生成任务，请稍候。' }
  }
  if (!ownedLease.isCurrent()) { ownedLease.release(); return { kind: 'aborted' } }
  const assistantId = newStableId()
  let placeholderCreated = false
  let received = ''
  let reasoning = ''
  let lastRender = 0
  let lastDurable = -Infinity
  let renderTimer: ReturnType<typeof setTimeout> | undefined
  let durableTimer: ReturnType<typeof setTimeout> | undefined
  const checkpoint = () => {
    durableTimer = undefined
    if (!ownedLease.isCurrent()) return
    lastDurable = Date.now()
    thread.persistCheckpoint?.(received)
  }
  const onDelta = (d: string) => {
    received += d
    if (thread.persistCheckpoint && durableTimer === undefined) {
      const delay = DURABLE_CHECKPOINT_MS - (Date.now() - lastDurable)
      if (delay <= 0) checkpoint()
      else durableTimer = setTimeout(checkpoint, delay)
    }
    const elapsed=Date.now()-lastRender
    if(elapsed>=STREAM_RENDER_INTERVAL_MS) {
      clearTimeout(renderTimer);renderTimer=undefined
      lastRender=Date.now();thread.updateAssistantContent(received)
    } else if(renderTimer===undefined) {
      // Flush the trailing delta even when the server pauses before its next
      // chunk. Throttling must delay rendering, never wait for completion.
      renderTimer=setTimeout(()=>{
        renderTimer=undefined
        if(!ownedLease.isCurrent() || controller.signal.aborted)return
        lastRender=Date.now();thread.updateAssistantContent(received)
      },STREAM_RENDER_INTERVAL_MS-elapsed)
    }
  }

  try {
    const contextMessages = acceptedSendContext?.logical.messages ?? await buildOcrAwareContext(await thread.getContextMessages())
    validateDocumentContext(contextMessages.flatMap(m=>m.documents || []), settings.chatProvider==='openai-local'?'':settings.apiBaseUrl, settings.chatProvider==='openai-local'?'':settings.model)
    const contextAttachments = await Promise.all(contextMessages.flatMap(x => x.images).map(async id => ({ id, meta: await getAttachment(id) })))
    const expectedImages = contextAttachments.filter(a => !a.meta?.ocr && !a.meta?.transcript).length
    const hasImages = expectedImages > 0
    const supportsImages = !hasImages || (settings.chatProvider === 'openai-local'
      ? (await getLocalStatus(controller.signal, 15000)).imageModels?.includes(settings.openaiLocalModel || '') === true
      : isVisionModel(settings.model, settings.visionCapability))
    if (hasImages && !supportsImages) {
      const failure: SendFailure = { kind: 'failed', code: 'vision-unsupported', message: attachmentErrorLabel('vision-unsupported') }
      ownedLease.release(); thread.setError(failure); return failure
    }
    // Provider limits differ. Never apply DeepSeek counts or an arbitrary raw
    // image-byte budget to OpenAI / compatible endpoints. Surface actual errors.
    const genUiPrompt = (await resolveCurrentProtocol('genui')).content
    const reqMessages = acceptedSendContext
      ? await projectLogicalPromptContext(acceptedSendContext.logical, acceptedSendContext.compilePolicy.systemMessagePolicy, toDataUrl, { genUi: true, genUiPrompt })
      : await buildApiMessages(contextMessages, toDataUrl)
    if (!acceptedSendContext) appendGenUiGuidance(reqMessages, genUiPrompt)
    const encodedImages = countImageParts(reqMessages)
    if (encodedImages !== expectedImages) {
      const failure: SendFailure = { kind: 'failed', code: 'attachment-encode-failed', message: '图片准备失败：已选择 ' + expectedImages + ' 张，实际仅准备成功 ' + encodedImages + ' 张。请检查附件后重试。' }
      ownedLease.release(); thread.setError(failure); return failure
    }

    // Stop/delete may have released the acceptance lease while local preflight was
    // awaiting attachments. Never create a placeholder or start a request after that.
    if (!ownedLease.isCurrent()) return { kind: 'aborted', ...(placeholderCreated ? { assistantMessageId: assistantId } : {}) }
    thread.createAssistantPlaceholder(assistantId, Date.now())
    placeholderCreated = true
    if (!ownedLease.setStreaming()) {
      thread.settleAssistant('aborted', errorKindLabel('aborted'))
      await thread.persistFinal()
      await thread.drainWrites()
      return { kind: 'aborted', assistantMessageId: assistantId }
    }
    thread.setStreaming()
    if (onStreamStart) onStreamStart(controller, assistantId)
    const userMessages = contextMessages.filter(message => message.role === 'user')
    const question = userMessages.at(-1)?.content || ''
    const firecrawl = hasFirecrawlWebSearch(settings)
    const firecrawlEnabled = firecrawl && isWebSearchEnabled(settings)
    const nativeSettings = firecrawl ? { ...settings, webSearchEnabled: false } : settings
    const native = nativeConversationOptions(nativeSettings, reqMessages, !!thread.acceptTitle && userMessages.length === 1)
    let webFooter = ''
    if (!firecrawl && settings.webSearchEnabled && settings.chatProvider !== 'openai-local' && !native) {
      const research = await prepareWebResearch({ baseUrl: settings.apiBaseUrl, apiKey: settings.apiKey, question, signal: controller.signal })
      if (!ownedLease.isCurrent()) throw new DeepSeekError('aborted', 'Aborted')
      reqMessages.push(research.message)
      webFooter = research.footer
    }
    const r = await streamProviderChat(settings, {
      apiKey: settings.apiKey, baseUrl: settings.apiBaseUrl, model: settings.model, messages: reqMessages,
      signal: controller.signal, onDelta, onReasoningDelta: delta => { reasoning += delta }, ...native,
      ...(firecrawlEnabled ? {
        nativeTools: [],
        onWebToolCalls: async calls => {
          const queries = getToolQueries(calls).map(call => searchQuery(call.name, call.args))
          const index = queries.findIndex(Boolean)
          const results = queries.map(query => ({ status: query ? 'search_limit' : 'invalid_query' }) as Record<string, unknown>)
          if (index < 0) return results
          if (!ownedLease.isCurrent()) throw new DeepSeekError('aborted', 'Aborted')
          const research = await prepareFirecrawlResearch({ settings, query: queries[index], signal: controller.signal })
          if (!ownedLease.isCurrent()) throw new DeepSeekError('aborted', 'Aborted')
          webFooter = research.footer
          results[index] = research.result
          return results
        },
      } : {}),
    })
    if (r.webToolUnavailable) webFooter = '\n\n---\n\n' + tx('当前模型接口不支持 Firecrawl 搜索工具。', 'This model endpoint does not support the Firecrawl search tool.')
    clearTimeout(renderTimer);renderTimer=undefined
    received = r.content + webFooter + citationFooter(r.annotations)
    clearTimeout(durableTimer)
    thread.updateAssistantContent(received, r.usage, { serverToolCalls: r.serverToolCalls, annotations: r.annotations, reasoning: r.reasoning })
    if (typeof r.title==='string') thread.acceptTitle?.(r.title)
    if (!(await thread.exists())) throw new DeepSeekError('aborted', '目标已删除')
    await thread.persistFinal()
    await thread.drainWrites()
    thread.setIdle()
    return { kind: 'completed', assistantMessageId: assistantId }
  } catch (e) {
    clearTimeout(renderTimer);renderTimer=undefined
    clearTimeout(durableTimer)
    if (placeholderCreated) thread.updateAssistantContent(received)
    if (placeholderCreated && reasoning.trim()) thread.updateAssistantContent(received, undefined, { reasoning })
    if (e instanceof AttachmentError) {
      const failure: SendFailure = { kind: 'failed', code: 'attachment-' + e.kind, message: attachmentErrorLabel(e.kind), ...(placeholderCreated ? { assistantMessageId: assistantId } : {}) }
      if (placeholderCreated) thread.settleAssistant('failed', failure.message)
      await thread.persistFinal()
      await thread.drainWrites()
      ownedLease.release(); thread.setError(failure); return failure
    }
    const err = e instanceof DeepSeekError ? e : new DeepSeekError(controller.signal.aborted ? 'aborted' : 'network-or-cors', 'Request failed')
    if (controller.signal.aborted || err.kind === 'aborted') {
      const message = errorKindLabel('aborted')
      if (placeholderCreated) thread.settleAssistant('aborted', message)
      await thread.persistFinal()
      await thread.drainWrites()
      ownedLease.release(); thread.setIdle()
      return { kind: 'aborted', ...(placeholderCreated ? { assistantMessageId: assistantId } : {}) }
    }
    const label = e instanceof WebResearchError || e instanceof LocalProviderError || e instanceof DeepSeekFilesError ? e.message : errorKindLabel(err.kind) + (err.status ? ('（HTTP ' + err.status + '）') : '')
    const failure: SendFailure = { kind: 'failed', code: e instanceof LocalProviderError ? e.code : err.kind, message: label, ...(placeholderCreated ? { assistantMessageId: assistantId } : {}) }
    if (placeholderCreated) thread.settleAssistant('failed', label)
    await thread.persistFinal()
    await thread.drainWrites()
    ownedLease.release()
    thread.setError(failure)
    return failure
  } finally {
    clearTimeout(renderTimer)
    clearTimeout(durableTimer)
    ownedLease.release()
  }
}
