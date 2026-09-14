export type TurnMessage = { id: string; role: string; content: string }

export type ConversationTurn = {
  id: string
  anchorMessageId: string
  userMessageId?: string
  assistantMessageId?: string
  preview: string
  weight: number
}

function previewOf(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 64) || '无文字内容'
}

/** One rail marker per user/assistant round. A leading assistant or trailing user is
 * still reachable, which keeps imported and interrupted conversations navigable. */
export function buildConversationTurns(messages: readonly TurnMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({
        id: message.id,
        anchorMessageId: message.id,
        userMessageId: message.id,
        preview: previewOf(message.content),
        weight: Math.min(1, Math.max(0.25, message.content.length / 240)),
      })
      continue
    }
    if (message.role !== 'assistant') continue
    const pending = turns[turns.length - 1]
    if (pending && !pending.assistantMessageId) {
      pending.assistantMessageId = message.id
      pending.weight = Math.min(1, Math.max(pending.weight, message.content.length / 900))
    } else {
      turns.push({
        id: message.id,
        anchorMessageId: message.id,
        assistantMessageId: message.id,
        preview: previewOf(message.content),
        weight: Math.min(1, Math.max(0.25, message.content.length / 900)),
      })
    }
  }
  return turns
}
