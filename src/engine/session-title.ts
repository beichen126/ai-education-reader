// Shared session-title helpers. Centralizing title rules so Sidebar (display + search),
// rename (sanitize), and tests all use the same semantics.
import type { Conversation } from './types'
import { NEW_TITLE } from './types'

export const MAX_TITLE_LEN = 80

/** User-visible title: formal title first, else auto from the first user message. */
export function displayTitle(s: Conversation): string {
  if (s.title && s.title !== NEW_TITLE) return s.title
  const first = s.messages.find((m) => m.role === 'user')
  if (!first) return '新会话'
  const raw = String(first.content || '')
  const stripped = raw.replace(/[*_~\[\]()#>]/g, '').replace(/\s+/g, ' ').trim()
  if (!stripped) return (first.images && first.images.length) ? '图片对话' : NEW_TITLE
  return stripped.length > 24 ? stripped.slice(0, 24) + '…' : stripped
}

/** Normalize a user-entered title: trim, drop empty/whitespace-only, cap length. */
export function sanitizeTitle(v: string): string {
  const t = String(v || '').trim()
  return t.length > MAX_TITLE_LEN ? t.slice(0, MAX_TITLE_LEN) : t
}

