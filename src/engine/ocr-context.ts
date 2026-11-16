import { buildContextMessages } from '../api/deepseek'
import { getAttachment } from './attachment-service'
import type { Message } from './types'

/** OCR is text context: the recent-image budget must not discard earlier OCR pages. */
export async function buildOcrAwareContext(messages: Message[]): Promise<Message[]> {
  const recent = buildContextMessages(messages)
  return Promise.all(recent.map(async (message, index) => {
    if (message.images.length || !messages[index].images.length) return message
    const ids: string[] = []
    for (const id of messages[index].images) if ((await getAttachment(id))?.ocr) ids.push(id)
    return ids.length ? { ...message, images: ids } : message
  }))
}
