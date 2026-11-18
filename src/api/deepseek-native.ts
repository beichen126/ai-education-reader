import { isOfficialDeepSeek } from './deepseek-files'
import type { ApiChatMessage, SendTextChatArgs } from './deepseek'
import type { Settings } from '../engine/settings-store'

export function supportsNativeDeepSeekSearch(settings: Settings) {
  return settings.chatProvider !== 'openai-local' && settings.model.trim().toLowerCase() === 'deepseek-flash' && isOfficialDeepSeek(settings.apiBaseUrl)
}

/** Native extensions are opt-in on gateways, which may implement only OpenAI chat. */
export function nativeConversationOptions(settings: Settings, messages: ApiChatMessage[], firstTurn: boolean, now = new Date()): Partial<SendTextChatArgs> | undefined {
  if (settings.chatProvider==='openai-local' || settings.model.trim().toLowerCase()!=='deepseek-flash' || (!isOfficialDeepSeek(settings.apiBaseUrl) && !settings.nativeDeepSeekProxy)) {
    for (const message of messages) delete message.server_tool_calls
    return undefined
  }
  if (settings.userMetadataEnabled!==false) {
    const index = messages.map(m=>m.role).lastIndexOf('user')
    const english = settings.uiLanguage==='en'
    const date = [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-')
    const weekday = new Intl.DateTimeFormat(english?'en':'zh-CN',{weekday:'long'}).format(now)
    const platform = typeof location!=='undefined' && location.hostname==='appassets.androidplatform.net' ? 'App' : 'Web'
    if (index>=0) messages.splice(index,0,{role:'latest_reminder',content:[date,weekday,(settings.userLocation||'').replace(/[\r\n]/g,' ').slice(0,160),platform,english?'English':'中文'].join(',')})
  }
  const official = supportsNativeDeepSeekSearch(settings)
  const search = official && settings.deepseekWebSearchEnabled !== false
  return {
    ...(search ? {thinking:'enabled' as const} : {}),
    nativeTools:[...(search?['deepseek_web_search']:[]),...(official && settings.readUrlEnabled!==false?['deepseek_read_url']:[])],
    generateTitle:firstTurn && settings.autoTitleEnabled!==false,
  }
}

export function citationFooter(annotations?: unknown[]): string {
  const links = new Map<string,string>()
  for (const entry of annotations || []) {
    const citation = (entry as any)?.url_citation
    if ((entry as any)?.type!=='url_citation' || typeof citation?.url!=='string') continue
    try {
      const url = new URL(citation.url)
      if (!['https:','http:'].includes(url.protocol)) continue
      links.set(url.href, String(citation.title || url.hostname).replace(/[\[\]\r\n\\]/g,' ').slice(0,200))
    } catch { /* Ignore malformed provider URLs. */ }
  }
  return links.size ? '\n\n---\n\n'+[...links].map(([url,title],i)=>`[${i+1}. ${title}](<${url.replace(/>/g,'%3E')}>)`).join(' · ') : ''
}
