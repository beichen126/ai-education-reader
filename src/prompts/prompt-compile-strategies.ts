import { buildApiMessages, type ApiChatMessage } from '../api/deepseek'
import type { ChatThreadRef } from '../branches/branch-types'
import type { Message, StableId } from '../engine/types'
import type { PromptSnapshot } from './prompt-types'

export type LogicalPromptSegment = {
  transitionId: StableId
  afterMessageId: StableId | null
  snapshot: PromptSnapshot
  /** Message ids covered by this snapshot; the boundary message is owned by the previous segment. */
  messageIds: StableId[]
}

export type LogicalPromptBinding = {
  role: 'system' | 'user'
  placement: 'before-messages' | 'after-messages'
  snapshot: PromptSnapshot
}

export type LogicalPromptContext = {
  domain: string
  thread?: ChatThreadRef
  messages: Message[]
  transitions: import('./prompt-types').PromptTransition[]
  segments: LogicalPromptSegment[]
  bindings: LogicalPromptBinding[]
}

export type PromptImageResolver = (attachmentId: StableId) => Promise<string>

function safeImageResolver(): PromptImageResolver {
  return async (attachmentId) => { throw new Error('missing image resolver for attachment ' + attachmentId) }
}

function systemMessage(snapshot: PromptSnapshot): ApiChatMessage {
  return { role: 'system', content: snapshot.content }
}

function userMessage(snapshot: PromptSnapshot): ApiChatMessage {
  return { role: 'user', content: snapshot.content }
}

/** JSON framing makes prompt content safe even when it contains delimiter-looking text. */
export function buildFlattenedPromptSummary(segments: readonly LogicalPromptSegment[]): string {
  const current = segments.length > 0 ? segments[segments.length - 1].snapshot : undefined
  let messageCursor = 0
  const frame = {
    format: 'ai-education-reader.prompt-timeline.v1',
    instruction: '历史 assistant 回复应理解为在各自 segment 的模式下生成；当前回复遵守 currentMode。',
    segments: segments.map((segment, index) => {
      const startInclusive = messageCursor
      const endExclusive = startInclusive + segment.messageIds.length
      messageCursor = endExclusive
      return {
        ordinal: index + 1,
        messageRange: { startInclusive, endExclusive },
        name: segment.snapshot.name,
        revision: segment.snapshot.revision ?? null,
        content: segment.snapshot.content,
      }
    }),
    currentMode: current ? {
      name: current.name,
      revision: current.revision ?? null,
      content: current.content,
    } : null,
  }
  return 'Prompt Timeline\n' + JSON.stringify(frame)
}

/** Deterministic transport frame for ending a previously non-empty mode. */
export function buildEmptyDefaultModeFrame(snapshot: PromptSnapshot): string {
  return 'Prompt Timeline\n' + JSON.stringify({
    format: 'ai-education-reader.prompt-timeline.v1',
    event: 'current-mode-reset',
    currentMode: {
      name: snapshot.name,
      revision: snapshot.revision ?? null,
      content: '',
    },
  })
}

async function historyMessages(messages: readonly Message[], toDataUrl: PromptImageResolver): Promise<ApiChatMessage[]> {
  return buildApiMessages(messages.map((message) => ({ ...message, images: [...message.images] })), toDataUrl)
}

/** Project the provider-neutral logical context without changing message order or image parts. */
export async function projectLogicalPromptContext(
  context: LogicalPromptContext,
  policy: 'interleaved' | 'flattened',
  toDataUrl: PromptImageResolver = safeImageResolver(),
): Promise<ApiChatMessage[]> {
  const history = await historyMessages(context.messages, toDataUrl)

  if (context.domain === 'conversation') {
    const hasNonEmptyMode = context.segments.some((segment) => segment.snapshot.content.length > 0)
    if (policy === 'flattened') {
      return hasNonEmptyMode
        ? [{ role: 'system', content: buildFlattenedPromptSummary(context.segments) }, ...history]
        : history
    }

    const byStart = new Map<number, LogicalPromptSegment[]>()
    const positions = new Map(context.messages.map((message, index) => [message.id, index]))
    for (const segment of context.segments) {
      const start = segment.afterMessageId === null ? 0 : (positions.get(segment.afterMessageId) ?? -1) + 1
      const list = byStart.get(start) ?? []
      list.push(segment)
      byStart.set(start, list)
    }
    const out: ApiChatMessage[] = []
    let hasSeenNonEmptyMode = false
    for (let index = 0; index <= history.length; index++) {
      for (const segment of byStart.get(index) ?? []) {
        if (segment.snapshot.content) {
          out.push(systemMessage(segment.snapshot))
          hasSeenNonEmptyMode = true
        } else if (hasNonEmptyMode && hasSeenNonEmptyMode) {
          out.push({ role: 'system', content: buildEmptyDefaultModeFrame(segment.snapshot) })
        }
      }
      if (index < history.length) out.push(history[index])
    }
    return out
  }

  const before = context.bindings.filter((binding) => binding.placement === 'before-messages')
  const after = context.bindings.filter((binding) => binding.placement === 'after-messages')
  return [
    ...before.map((binding) => systemMessage(binding.snapshot)),
    ...history,
    ...after.map((binding) => userMessage(binding.snapshot)),
  ]
}
