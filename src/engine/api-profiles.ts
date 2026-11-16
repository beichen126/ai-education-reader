import type { Settings } from './settings-store'
export const PROFILE_FIELDS = ['apiBaseUrl','apiKey','model','visionCapability','webSearchEnabled','readUrlEnabled','autoTitleEnabled','userMetadataEnabled','nativeDeepSeekProxy','speechApiUrl','speechApiKey','speechVoice'] as const
export type ApiProfileConfig = Pick<Settings, typeof PROFILE_FIELDS[number]>
export type ApiProfile = {id:string;name:string;config:ApiProfileConfig}
export function profileConfig(settings: Settings): ApiProfileConfig {
 return Object.fromEntries(PROFILE_FIELDS.map(key=>[key,settings[key]])) as ApiProfileConfig
}
export function parseProfiles(value: unknown): ApiProfile[] {
 try {
  const rows = typeof value==='string'?JSON.parse(value):value
  if (!Array.isArray(rows)) return []
  const seen=new Set<string>()
  return rows.filter(p=>p && typeof p.id==='string' && !seen.has(p.id) && seen.add(p.id) && typeof p.name==='string' && p.name.trim() && p.config && typeof p.config.apiBaseUrl==='string' && typeof p.config.apiKey==='string' && typeof p.config.model==='string').map(p=>({id:p.id,name:p.name.trim().slice(0,60),config:profileConfig(p.config)}))
 } catch {return []}
}
