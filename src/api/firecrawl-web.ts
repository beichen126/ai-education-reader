import { tx } from '../engine/locale'
import type { Settings } from '../engine/settings-store'
import { configuredImageKeys, requestWithImageKeys } from '../web-images/key-pool'
import { withRequestDeadline } from './request-deadline'

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'does', 'about', 'please', '是什么', '请问', '一下'])

export function hasFirecrawlWebSearch(settings: Settings) {
  return configuredImageKeys(settings).length > 0
}

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
    url.hash = ''
    return url.href
  } catch { return undefined }
}

function terms(text: string) {
  if (/免费|定价|计费|额度|每月/.test(text)) text += ' free pricing credits monthly billing'
  if (/版本|字段|文档/.test(text)) text += ' version field documentation'
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]+|[\p{Script=Han}]+/gu) || []
  const tokens = words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 2
    ? [word, ...Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))]
    : [word])
  return [...new Set(tokens.filter(word => !STOP_WORDS.has(word)))].slice(0, 75)
}

function relevance(text: string, tokens: string[]) {
  const lower = text.toLowerCase()
  return tokens.reduce((score, token) => score + (lower.includes(token) ? Math.min(token.length, 9) : 0), 0)
}

export function excerptFirecrawlPage(markdown: string, query: string) {
  const tokens = terms(query)
  // Score overlapping windows throughout the document, including tables and code sections.
  const chunks = Array.from({ length: Math.ceil(markdown.length / 900) }, (_, index) => {
    const from = index * 900
    const text = markdown.slice(Math.max(0, from - 100), from + 1000).trim()
    return { index, text, score: relevance(text, tokens) }
  }).sort((a, b) => b.score - a.score || a.index - b.index)
  const best = chunks[0]
  if (!best?.score) return markdown.trim().slice(0, 1000)
  const second = chunks.find(chunk => chunk.score && Math.abs(chunk.index - best.index) > 1)
  return (second ? [best, second] : [best]).sort((a, b) => a.index - b.index).map(chunk => chunk.text).join('\n\n…\n\n')
}

type Result = { url?: unknown; title?: unknown; description?: unknown }
type FirecrawlReply = {
  success?: boolean
  creditsUsed?: number
  data?: { web?: Result[]; markdown?: string; metadata?: { creditsUsed?: number; statusCode?: number } }
}
type Source = { url: string; title: string; summary: string; excerpt?: string }
type Usage = { searches: number; reads: number; credits: number; complete: boolean }

async function request(
  keys: ReturnType<typeof configuredImageKeys>,
  endpoint: 'search' | 'scrape',
  body: Record<string, unknown>,
  signal: AbortSignal,
  usage: Usage,
): Promise<FirecrawlReply> {
  const timeout = endpoint === 'search' ? 9000 : 4000
  return requestWithImageKeys(keys, key => withRequestDeadline(signal, timeout + 1000, async attempt => {
    signal.throwIfAborted()
    if (endpoint === 'search') usage.searches++
    else usage.reads++
    let response: Response
    try {
      response = await fetch('https://api.firecrawl.dev/v2/' + endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, timeout }),
        signal: attempt,
      })
    } catch {
      usage.complete = false
      throw Object.assign(new Error('Firecrawl request failed'), { terminal: true })
    }
    if (!response.ok) {
      const rotate = [401, 402, 429].includes(response.status) || (endpoint === 'search' && response.status === 403)
      if (!rotate) usage.complete = false
      throw Object.assign(new Error('Firecrawl HTTP ' + response.status), { status: response.status, terminal: !rotate })
    }
    const result = await response.json().catch(() => null) as FirecrawlReply | null
    const credits = result?.creditsUsed ?? result?.data?.metadata?.creditsUsed
    if (typeof credits === 'number' && Number.isFinite(credits) && credits >= 0) usage.credits += credits
    else usage.complete = false
    if (!result?.success) throw Object.assign(new Error('Invalid Firecrawl response'), { terminal: true })
    return result
  }), signal)
}

function footer(sources: Source[], usage: Usage, status = '') {
  const credits = usage.complete ? String(usage.credits) : usage.credits ? '≥' + usage.credits : '—'
  const totals = tx(
    'Firecrawl · 搜索 ' + usage.searches + ' 次 · 读取 ' + usage.reads + ' 次 · ' + credits + ' credits',
    'Firecrawl · ' + usage.searches + ' search attempts · ' + usage.reads + ' page read attempts · ' + credits + ' credits',
  )
  const links = sources.map(({ title, url, excerpt }, index) => {
    const safeTitle = title.replace(/[\[\]\\*<>_\r\n\x60]/g, ' ')
    return (index + 1) + '. [' + safeTitle + '](<' + url.replace(/>/g, '%3E') + '>) · ' +
      (excerpt ? tx('网页正文', 'Page excerpt') : tx('搜索摘要', 'Search summary'))
  })
  return '\n\n---\n\n' + [totals, status, links.join('\n')].filter(Boolean).join('\n\n')
}

export async function prepareFirecrawlResearch(input: {
  settings: Settings
  query: string
  signal: AbortSignal
}) {
  const { settings, query, signal } = input
  const keys = configuredImageKeys(settings)
  const usage: Usage = { searches: 0, reads: 0, credits: 0, complete: true }
  const seen = new Set<string>()
  const sources: Source[] = []
  try {
    const result = await withRequestDeadline(signal, 11_000, deadline => request(keys, 'search', { query, sources: ['web'], limit: 5 }, deadline, usage))
    if (!Array.isArray(result.data?.web)) throw new Error('Missing Firecrawl web results')
    for (const item of result.data.web.slice(0, 5)) {
      const url = publicUrl(item?.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      sources.push({
        url, title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 200) : new URL(url).hostname,
        summary: typeof item.description === 'string' ? item.description.trim().slice(0, 1400) : '',
      })
    }
  } catch {
    signal.throwIfAborted()
    return { result: { status: 'unavailable' }, footer: () => footer([], usage, tx('网页搜索未完成，本轮基于已有上下文回答。', 'Web search did not complete. The reply uses the existing context.')) }
  }

  if (!sources.length) return { result: { status: 'no_results' }, footer: () => footer([], usage, tx('本轮未找到可用网页。', 'No usable webpages found.')) }

  const results = () => sources.map((source, index) => ({ number: index + 1, ...source }))
  const read = async (numbers: number[]) => withRequestDeadline(signal, 11_000, async deadline => {
    const pages: { number: number; url: string; excerpt?: string; status: string }[] = []
    const selected = [...new Set(numbers)].filter(number => Number.isInteger(number) &&
      number >= 1 && number <= sources.length && !/\.pdf$/i.test(new URL(sources[number - 1].url).pathname)).slice(0, 2)
    for (const number of selected) {
      if (deadline.aborted) break
      const source = sources[number - 1]
      try {
        const page = await request(keys, 'scrape', { url: source.url, formats: ['markdown'], onlyMainContent: true, parsers: [] }, deadline, usage)
        const status = page.data?.metadata?.statusCode
        if ((!status || (status >= 200 && status < 300)) && typeof page.data?.markdown === 'string') {
          source.excerpt = excerptFirecrawlPage(page.data.markdown, query) || undefined
        }
      } catch {
        if (signal.aborted) throw signal.reason
      }
      pages.push({ number, url: source.url, excerpt: source.excerpt, status: source.excerpt ? 'ok' : 'unavailable' })
    }
    return { status: selected.length ? 'completed' : 'invalid_selection', pages }
  })
  return { result: { status: 'ok', sources: results() }, footer: () => footer(sources, usage), read }
}
