import { getSettingsSnapshot } from './settings-store'
import { isOfficialDeepSeek } from '../api/deepseek-files'

export function deepSeekServiceProfiles() {
  const settings = getSettingsSnapshot()
  const profiles = (settings.apiProfiles || []).filter(p => isOfficialDeepSeek(p.config.apiBaseUrl) && p.config.apiKey.trim())
  if (isOfficialDeepSeek(settings.apiBaseUrl) && settings.apiKey.trim()) {
    return [{ id: '__current__', name: '当前 DeepSeek 官方配置', config: settings }, ...profiles.filter(p => p.id !== settings.activeApiProfileId)]
  }
  return profiles
}
let selectedProfileId = ''
export function selectDeepSeekServiceProfile(id: string) { selectedProfileId = id }
export function selectedDeepSeekServiceProfile() { const profiles = deepSeekServiceProfiles(); return profiles.find(p => p.id === selectedProfileId) || profiles[0] }

