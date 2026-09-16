import { useSyncExternalStore } from 'react'

export type UiLanguage = 'zh-CN' | 'en'

const LANGUAGE_HINT_KEY = 'aer-ui-language'

const dictionaries: Record<UiLanguage, Record<string, string>> = {
  'zh-CN': {
    'brand.localBuild': 'AI 学习阅读器',
    'sidebar.newChat': '新建会话',
    'sidebar.search': '搜索会话…',
    'conversation.emptyHero': '开始新的对话',
    'conversation.emptyHint': '在上方输入框提问，或通过附件上传教材图片。',
    'composer.placeholder': '输入消息，Enter 发送…',
    'composer.send': '发送',
    'composer.attach': '上传图片',
    'common.close': '关闭',
    'attachment.view': '查看图片',
    'assistant.placeholder': 'AI 回复接入后将在此显示。',
  },
  en: {
    'brand.localBuild': 'AI Education Reader',
    'sidebar.newChat': 'New chat',
    'sidebar.search': 'Search chats…',
    'conversation.emptyHero': 'Start a new chat',
    'conversation.emptyHint': 'Ask a question above, or upload textbook images as attachments.',
    'composer.placeholder': 'Message, press Enter to send…',
    'composer.send': 'Send',
    'composer.attach': 'Upload image',
    'common.close': 'Close',
    'attachment.view': 'View image',
    'assistant.placeholder': 'The AI response will appear here.',
  },
}

let current: UiLanguage = 'zh-CN'
const subscribers = new Set<() => void>()

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === 'en' ? 'en' : 'zh-CN'
}

export function getUiLanguage(): UiLanguage { return current }

/** Apply language immediately to React subscribers and document metadata. The small
 * localStorage hint lets index.html set lang before IndexedDB and React have loaded. */
export function applyUiLanguage(value: unknown): UiLanguage {
  const next = normalizeUiLanguage(value)
  if (typeof document !== 'undefined') document.documentElement.lang = next
  try { localStorage.setItem(LANGUAGE_HINT_KEY, next) } catch { /* unavailable storage */ }
  if (next !== current) {
    current = next
    subscribers.forEach(fn => fn())
  }
  return next
}

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(
    fn => { subscribers.add(fn); return () => { subscribers.delete(fn) } },
    () => current,
    () => 'zh-CN',
  )
}

export function t(key: string, opts?: Record<string, unknown>): string {
  const s = dictionaries[current][key] ?? dictionaries['zh-CN'][key]
  if (s === undefined) return key
  if (opts) return s.replace(/\{\w+\}/g, m => String(opts[m.slice(1, -1)] ?? ''))
  return s
}

/** Compact helper for UI copy that does not need a reusable message id. */
export function tx(zh: string, en: string): string { return current === 'en' ? en : zh }

export const locale = { t }
