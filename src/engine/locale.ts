
const dict: Record<string, string> = {
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
}
export function t(key: string, opts?: any): string {
  const s = dict[key]
  if (s === undefined) return key
  if (opts) return s.replace(/\{\w+\}/g, (m: string) => String(opts[m.slice(1, -1)] ?? ''))
  return s
}
export const locale = { t }
