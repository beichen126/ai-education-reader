import { newStableId, type Message, type StableId } from './types'
import type { Settings } from './settings-store'
import { buildContextMessages, buildApiMessages, buildRequestMessages, streamTextChat, countImageParts, isVisionModel, exceedsVisionImageCount, DeepSeekError, errorKindLabel } from '../api/deepseek'
import { toDataUrl, AttachmentError, attachmentErrorLabel, sumAttachmentBytes, isInlineImageOverBudget } from './attachment-service'
import { generationRegistry } from './generation-registry'

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
  setError(message: string): void
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
export async function runThreadReply(thread: ReplyThread, settings: Settings, controller: AbortController, onStreamStart?: (controller: AbortController, assistantId: StableId) => void): Promise<{ content: string; aborted: boolean }> {
  const assistantId = newStableId()
  let received = ''
  let lastRender = 0
  let lastDurable = 0
  const update = (content: string, flushDurable: boolean) => {
    thread.updateAssistantContent(content)
    if (flushDurable && Date.now() - lastDurable >= DURABLE_CHECKPOINT_MS) { lastDurable = Date.now(); thread.persistCheckpoint(content) }
  }
  const onDelta = (d: string) => { received += d; const t = Date.now(); if (t - lastRender >= STREAM_RENDER_INTERVAL_MS) { lastRender = t; update(received, false) } }

  try {
    const contextMessages = buildContextMessages(await thread.getContextMessages())
    const hasImages = contextMessages.some((x) => x.images.length > 0)
    if (hasImages && !isVisionModel(settings.model, settings.visionCapability)) { thread.setError(attachmentErrorLabel('vision-unsupported')); return { content: '', aborted: false } }
    const retainedImageIds = contextMessages.flatMap((x) => x.images)
    if (retainedImageIds.length > 0) {
      const totalImageBytes = await sumAttachmentBytes(retainedImageIds)
      if (isInlineImageOverBudget(totalImageBytes)) { thread.setError('当前消息包含的图片数据过多，可能超过模型接口的请求大小限制。请减少本次选择的 PDF 页数或图片数量。'); return { content: '', aborted: false } }
      const retainedImages = contextMessages.reduce((sum, mm) => sum + mm.images.length, 0)
      if (exceedsVisionImageCount(retainedImages)) { thread.setError('当前对话需要发送的图片数量过多。请减少本次 PDF 页面或图片后重试。'); return { content: '', aborted: false } }
    }
    const apiMessages = await buildApiMessages(contextMessages, toDataUrl)
    const reqMessages = buildRequestMessages(apiMessages, settings)
    const expectedImages = contextMessages.reduce((sum, mm) => sum + mm.images.length, 0)
    const encodedImages = countImageParts(reqMessages)
    if (encodedImages !== expectedImages) { thread.setError('图片准备失败：已选择 ' + expectedImages + ' 张，实际仅准备成功 ' + encodedImages + ' 张。请检查附件后重试。'); return { content: '', aborted: false } }

    thread.createAssistantPlaceholder(assistantId, Date.now())
    thread.setStreaming()
    generationRegistry.begin(thread.genKey, controller, 'streaming')
    if (onStreamStart) onStreamStart(controller, assistantId)
    const r = await streamTextChat({ apiKey: settings.apiKey, baseUrl: settings.apiBaseUrl, model: settings.model, messages: reqMessages, signal: controller.signal, onDelta })
    received = r.content
    update(received, true)
    if (!(await thread.exists())) throw new DeepSeekError('aborted', '目标已删除')
    await thread.persistFinal()
    await thread.drainWrites()
    generationRegistry.end(thread.genKey)
    thread.setIdle()
    return { content: received, aborted: false }
  } catch (e) {
    update(received, true)
    await thread.persistFinal()
    await thread.drainWrites()
    generationRegistry.end(thread.genKey)
    if (e instanceof AttachmentError) { thread.setError(attachmentErrorLabel(e.kind)); return { content: received, aborted: false } }
    const err = e instanceof DeepSeekError ? e : new DeepSeekError('network-or-cors', String(e))
    if (err.kind === 'aborted') { thread.setIdle(); return { content: received, aborted: true } }
    const label = errorKindLabel(err.kind) + (err.status ? ('（HTTP ' + err.status + '）') : '')
    thread.setError(label)
    return { content: received, aborted: false }
  }
}
