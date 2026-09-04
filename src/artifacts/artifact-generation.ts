import { type StableId, type Message } from '../engine/types'
import { getSettingsSnapshot } from '../engine/settings-store'
import { buildContextMessages, buildApiMessages, buildRequestMessages, type ApiChatMessage } from '../api/deepseek'
import { toDataUrl, AttachmentError } from '../engine/attachment-service'
import { globalGenerationLock } from '../engine/chat-generation-service'
import { getArtifact } from './artifact-store'
import { markArtifactReady, markArtifactError, materializeSourceMessages } from './artifact-service'
import { parseQuizDocument, QuizValidationError } from './artifact-validation'
import type { StudyArtifact } from './artifact-types'

export class ArtifactGenerationError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ArtifactGenerationError' } }

/** Injectable model-call seam so generation is unit-testable without a network. */
export type ArtifactModelCall = (args: { apiKey: string; baseUrl: string; model: string; messages: ApiChatMessage[]; signal: AbortSignal }) => Promise<string>

/**
 * Generate a Study Artifact from its frozen source. One global model generation (the lock
 * is shared with chat). Source input is the immutable snapshot captured at creation-must
 * never drift to later messages. On success it finalizes 'ready'; on malformed quiz output
 * it marks 'error' (retryable); on missing source binaries it reports 资料不可用. Stale
 * writes (artifact edited while generating) are dropped by the updatedAt guard.
 */
export async function generateArtifact(artifactId: StableId, opts: { call: ArtifactModelCall }): Promise<StudyArtifact> {
  const a = await getArtifact(artifactId)
  if (!a) throw new ArtifactGenerationError('not-found', '学习成果不存在')
  // Regeneration must NEVER silently overwrite a finalized + possibly-edited artifact.
  // The caller creates a NEW revision draft for regeneration; the old one stays safe.
  if (a.status === 'ready') throw new ArtifactGenerationError('already-finalized', '该学习成果已完成，如需重新生成请先创建新版本')
  const key = 'artifact:' + artifactId
  const controller = new AbortController()
  if (!globalGenerationLock.tryAcquire(key, controller)) throw new ArtifactGenerationError('busy', '已有模型任务正在进行，请稍后再试')
  const startUpdatedAt = a.updatedAt
  try {
    const settings = getSettingsSnapshot()
    if (!settings.apiKey) { await markArtifactError(artifactId, '未配置 API Key'); throw new ArtifactGenerationError('no-api-key', '未配置 API Key') }
    // Frozen source: never re-read the live conversation, never include later messages.
    const sourceMsgs = materializeSourceMessages(a.source)
    const contextMsgs = buildContextMessages(sourceMsgs)
    let apiMsgs: ApiChatMessage[]
    try { apiMsgs = await buildApiMessages(contextMsgs, toDataUrl) }
    catch (e) {
      if (e instanceof AttachmentError) {
        await markArtifactError(artifactId, '原始资料已不可用，无法按原上下文重新生成。')
        throw new ArtifactGenerationError('source-unavailable', '原始资料已不可用，无法按原上下文重新生成。')
      }
      throw e
    }
    const reqMsgs = buildRequestMessages(apiMsgs, settings)
    reqMsgs.push({ role: 'user', content: a.prompt })
    const content = await opts.call({ apiKey: settings.apiKey, baseUrl: settings.apiBaseUrl, model: settings.model, messages: reqMsgs, signal: controller.signal })
    // Late/fresh re-check: if the artifact was edited or deleted while we generated, the
    // result must be dropped (a late write can never overwrite a newer revision).
    const fresh = await getArtifact(artifactId)
    if (!fresh || fresh.updatedAt !== startUpdatedAt || fresh.status !== 'generating'
        || (fresh.content ?? '') !== (a.content ?? '') || JSON.stringify(fresh.quiz ?? null) !== JSON.stringify(a.quiz ?? null)) {
      throw new ArtifactGenerationError('stale', '学习成果已更新，本次结果已丢弃')
    }
    if (a.kind === 'quiz') {
      try {
        const quiz = parseQuizDocument(content)
        const out = await markArtifactReady(artifactId, { quiz, generatedText: content }, a.updatedAt)
        if (!out) throw new ArtifactGenerationError('stale', '学习成果已更新，本次结果已丢弃')
        return out
      } catch (e) {
        if (e instanceof QuizValidationError) {
          await markArtifactError(artifactId, '生成的题目结构不合法，请重试。')
          throw new ArtifactGenerationError('invalid-quiz', '生成的题目结构不合法，请重试。')
        }
        throw e
      }
    }
    const out = await markArtifactReady(artifactId, { content, generatedText: content }, a.updatedAt)
    if (!out) throw new ArtifactGenerationError('stale', '学习成果已更新，本次结果已丢弃')
    return out
  } catch (e) {
    if (e instanceof ArtifactGenerationError) { throw e }
    const isAbort = (e as any)?.name === 'AbortError'
    await markArtifactError(artifactId, isAbort ? '已取消' : '生成失败：' + String((e as any)?.message ?? e))
    throw e
  } finally {
    globalGenerationLock.release(key)
  }
}
