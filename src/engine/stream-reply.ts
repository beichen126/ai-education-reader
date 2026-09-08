import { newStableId, type Message, type StableId } from './types'
import type { Settings } from './settings-store'
import { buildContextMessages, buildApiMessages, streamTextChat, countImageParts, isVisionModel, exceedsVisionImageCount, DeepSeekError, errorKindLabel } from '../api/deepseek'
import { toDataUrl, AttachmentError, attachmentErrorLabel, sumAttachmentBytes, isInlineImageOverBudget } from './attachment-service'
import { generationRegistry, type GenerationLease } from './generation-registry'
import { projectLogicalPromptContext } from '../prompts/prompt-compile-strategies'
import type { AcceptedSendContext } from '../prompts/prompt-send'
import type { SendFailure, SendOutcome } from './send-outcome'

/**
 * Thread-agnostic streaming reply engine. ONE generation pipeline is shared by the ROOT
 * conversation and every BRANCH. The target abstracts only the durable/rendering target:
 * context, placeholder placement, in-memory content update, ordered durable checkpoints,
 * status, and deletion guard. This is the single source of the stream/checkpoint/abort/
 * stale-write rules so root and branch behavior cannot drift.
 */
export interface ReplyThread {
  readonly genKey: string
  getContextMessages(): Message[] | Promise<Message[]>
  createAssistantPlaceholder(assistantId: StableId, now: number): void
  updateAssistantContent(content: string): void
  persistCheckpoint(content: string): void
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
  if (!ownedLease || ownedLease.key !== thread.genKey || ownedLease.controller !== controller || !ownedLease.isCurrent()) {
    return { kind: 'rejected', code: 'generation-busy', message: '当前已有生成任务，请稍候。' }
  }
  const assistantId = newStableId()
  let placeholderCreated = false
  let received = ''
  let lastRender = 0
  let lastDurable = 0
  const update = (content: string, flushDurable: boolean) => {
    thread.updateAssistantContent(content)
    if (flushDurable && Date.now() - lastDurable >= DURABLE_CHECKPOINT_MS) { lastDurable = Date.now(); thread.persistCheckpoint(content) }
  }
  const onDelta = (d: string) => { received += d; const t = Date.now(); if (t - lastRender >= STREAM_RENDER_INTERVAL_MS) { lastRender = t; update(received, false) } }

  try {
    const contextMessages = acceptedSendContext?.logical.messages ?? buildContextMessages(await thread.getContextMessages())
    const hasImages = contextMessages.some((x) => x.images.length > 0)
    if (hasImages && !isVisionModel(settings.model, settings.visionCapability)) {
      const failure: SendFailure = { kind: 'failed', code: 'vision-unsupported', message: attachmentErrorLabel('vision-unsupported') }
      ownedLease.release(); thread.setError(failure); return failure
    }
    const retainedImageIds = contextMessages.flatMap((x) => x.images)
    if (retainedImageIds.length > 0) {
      const totalImageBytes = await sumAttachmentBytes(retainedImageIds)
      if (isInlineImageOverBudget(totalImageBytes)) {
        const failure: SendFailure = { kind: 'failed', code: 'image-budget-exceeded', message: '当前消息包含的图片数据过多，可能超过模型接口的请求大小限制。请减少本次选择的 PDF 页数或图片数量。' }
        ownedLease.release(); thread.setError(failure); return failure
      }
      const retainedImages = contextMessages.reduce((sum, mm) => sum + mm.images.length, 0)
      if (exceedsVisionImageCount(retainedImages)) {
        const failure: SendFailure = { kind: 'failed', code: 'vision-image-limit', message: '当前对话需要发送的图片数量过多。请减少本次 PDF 页面或图片后重试。' }
        ownedLease.release(); thread.setError(failure); return failure
      }
    }
    const reqMessages = acceptedSendContext
      ? await projectLogicalPromptContext(acceptedSendContext.logical, acceptedSendContext.compilePolicy.systemMessagePolicy, toDataUrl)
      : await buildApiMessages(contextMessages, toDataUrl)
    const expectedImages = contextMessages.reduce((sum, mm) => sum + mm.images.length, 0)
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
    const r = await streamTextChat({ apiKey: settings.apiKey, baseUrl: settings.apiBaseUrl, model: settings.model, messages: reqMessages, signal: controller.signal, onDelta })
    received = r.content
    update(received, true)
    if (!(await thread.exists())) throw new DeepSeekError('aborted', '目标已删除')
    await thread.persistFinal()
    await thread.drainWrites()
    thread.setIdle()
    return { kind: 'completed', assistantMessageId: assistantId }
  } catch (e) {
    update(received, true)
    if (e instanceof AttachmentError) {
      const failure: SendFailure = { kind: 'failed', code: 'attachment-' + e.kind, message: attachmentErrorLabel(e.kind), ...(placeholderCreated ? { assistantMessageId: assistantId } : {}) }
      if (placeholderCreated) thread.settleAssistant('failed', failure.message)
      await thread.persistFinal()
      await thread.drainWrites()
      ownedLease.release(); thread.setError(failure); return failure
    }
    const err = e instanceof DeepSeekError ? e : new DeepSeekError('network-or-cors', String(e))
    if (err.kind === 'aborted') {
      const message = errorKindLabel('aborted')
      if (placeholderCreated) thread.settleAssistant('aborted', message)
      await thread.persistFinal()
      await thread.drainWrites()
      ownedLease.release(); thread.setIdle()
      return { kind: 'aborted', ...(placeholderCreated ? { assistantMessageId: assistantId } : {}) }
    }
    const label = errorKindLabel(err.kind) + (err.status ? ('（HTTP ' + err.status + '）') : '')
    const failure: SendFailure = { kind: 'failed', code: err.kind, message: label, ...(placeholderCreated ? { assistantMessageId: assistantId } : {}) }
    if (placeholderCreated) thread.settleAssistant('failed', label)
    await thread.persistFinal()
    await thread.drainWrites()
    ownedLease.release()
    thread.setError(failure)
    return failure
  } finally {
    ownedLease.release()
  }
}
