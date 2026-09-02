
export type StableId = string
export type MessageRole = 'user' | 'assistant'
/** Canonical attachment metadata. The binary blob lives in IndexedDB 'attachments' keyed by id. No base64/objectURL here. */
export type Attachment = { id: StableId; name: string; mimeType: string; size: number; createdAt: number; updatedAt: number }
/** Message holds only stable attachment id references, never objectURL/base64. */
export type Message = { id: StableId; role: MessageRole; content: string; images: StableId[]; createdAt: number; updatedAt: number }
export type Conversation = { id: StableId; title: string; createdAt: number; updatedAt: number; messages: Message[] }
export const NEW_TITLE = '新会话'
export function newStableId(): StableId { return globalThis.crypto.randomUUID() }
