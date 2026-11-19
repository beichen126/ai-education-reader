import { profileConfig, type ApiProfile, type ApiProfileConfig } from './api-profiles'
import type { Settings } from './settings-store'
import { configuredImageKeys } from '../web-images/key-pool'

const FORMAT = 'ai-education-reader-api-profiles'
export const MAX_API_PROFILE_FILE_BYTES = 1024 * 1024
export const MAX_FIRECRAWL_KEYS = 10
const FLAGS = ['webSearchEnabled', 'readUrlEnabled', 'autoTitleEnabled', 'userMetadataEnabled', 'nativeDeepSeekProxy'] as const
const VISION_OPTIONS = ['auto', 'supports-image', 'text-only']
const VOICES = ['stella', 'tide']

type TransferProfile = { name: string; config: Omit<ApiProfileConfig, 'apiKey'> & { apiKey?: string } }
type ProfileSettings = Pick<Settings, 'apiProfiles' | 'activeApiProfileId'> & ApiProfileConfig

export function savedApiProfiles(settings: ProfileSettings, originalName: string): ApiProfile[] {
  const id = settings.activeApiProfileId || 'initial'
  const rows = settings.apiProfiles || []
  return rows.some(row => row.id === id) ? rows : [...rows, { id, name: originalName, config: profileConfig(settings) }]
}

export function exportApiConfiguration(settings: Settings, originalName: string, includeKeys: boolean) {
  return {
    format: FORMAT,
    version: 2,
    profiles: savedApiProfiles(settings, originalName).map(({ name, config: { apiKey, ...config } }) => ({
      name, config: includeKeys ? { ...config, apiKey } : config,
    })),
    firecrawl: includeKeys ? { keys: configuredImageKeys(settings).map(item => item.key) } : {},
    speech: { baseUrl: settings.speechApiUrl || '', ...(includeKeys ? { apiKey: settings.speechApiKey || '' } : {}) },
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function option<T extends string>(value: unknown, choices: readonly string[], fallback: T): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !choices.includes(value)) throw new Error('invalid option')
  return value as T
}

export class ApiProfileFileError extends Error {
  constructor(readonly row?: number, readonly reason?: 'firecrawl-limit') { super('Invalid API configuration file') }
}

function endpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error()
  const base = value.trim()
  if (!base) return base
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error()
  return base
}

export function parseApiConfiguration(text: string) {
  let root: unknown
  try { root = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new ApiProfileFileError() }
  if (!record(root) || root.format !== FORMAT || (root.version !== 1 && root.version !== 2) || !Array.isArray(root.profiles)) throw new ApiProfileFileError()
  const profiles: TransferProfile[] = root.profiles.map((entry, index) => {
    try {
      if (!record(entry) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.trim().length > 60 || !record(entry.config)) throw new Error()
      const sourceConfig = entry.config
      const { apiBaseUrl, model, apiKey, visionCapability, speechVoice } = sourceConfig
      if (typeof model !== 'string' || !model.trim() || (apiKey !== undefined && typeof apiKey !== 'string')) throw new Error()
      const flags = Object.fromEntries(FLAGS.map(key => {
        const value = sourceConfig[key]
        if (value !== undefined && typeof value !== 'boolean') throw new Error()
        return [key, value]
      }))
      return { name: entry.name.trim(), config: {
        apiBaseUrl: endpoint(apiBaseUrl), model: model.trim(),
        ...(typeof apiKey === 'string' ? { apiKey: apiKey.trim() } : {}),
        visionCapability: option<ApiProfileConfig['visionCapability']>(visionCapability, VISION_OPTIONS, 'auto'),
        speechVoice: option<'stella' | 'tide'>(speechVoice, VOICES, 'stella'),
        ...flags,
      } }
    } catch { throw new ApiProfileFileError(index + 1) }
  })
  if (root.version === 1) return { profiles }
  try {
    if (!record(root.firecrawl) || !record(root.speech)) throw new Error()
    const keys = root.firecrawl.keys
    if (keys !== undefined && (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !key.trim()))) throw new Error()
    const firecrawlKeys = Array.isArray(keys) ? [...new Set(keys.map(key => (key as string).trim()))] : []
    if (firecrawlKeys.length > MAX_FIRECRAWL_KEYS) throw new ApiProfileFileError(undefined, 'firecrawl-limit')
    const speechKey = root.speech.apiKey
    if ((speechKey !== undefined && typeof speechKey !== 'string')) throw new Error()
    return { profiles, firecrawlKeys, speech: { baseUrl: endpoint(root.speech.baseUrl), apiKey: typeof speechKey === 'string' ? speechKey.trim() : undefined } }
  } catch (error) { throw error instanceof ApiProfileFileError ? error : new ApiProfileFileError() }
}

function sameOptions(a: TransferProfile['config'], b: ApiProfileConfig): boolean {
  return a.apiBaseUrl === b.apiBaseUrl
    && a.model === b.model
    && a.visionCapability === (b.visionCapability || 'auto')
    && a.speechVoice === (b.speechVoice || 'stella')
    && FLAGS.every(key => {
      const fallback = key !== 'webSearchEnabled' && key !== 'nativeDeepSeekProxy'
      return (a[key] ?? fallback) === (b[key] ?? fallback)
    })
    && (!a.apiKey || a.apiKey === b.apiKey)
}

export function mergeImportedApiProfiles(current: readonly ApiProfile[], imported: readonly TransferProfile[], createId: () => string) {
  const rows = [...current]
  const existingByName = new Map(rows.map(profile => [profile.name, profile]))
  for (const { name, config } of imported) {
    let candidate = name
    let existing = existingByName.get(candidate)
    for (let index = 2; existing && !sameOptions(config, existing.config); index++) {
      const suffix = ' (' + index + ')'
      candidate = name.slice(0, 60 - suffix.length) + suffix
      existing = existingByName.get(candidate)
    }
    if (existing) continue
    const profile = { id: createId(), name: candidate, config: { ...config, apiKey: config.apiKey || '' } }
    existingByName.set(candidate, profile)
    rows.push(profile)
  }
  return { rows, added: rows.length - current.length }
}
