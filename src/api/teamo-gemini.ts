export function isTeamoGemini(baseUrl: string, model: string): boolean {
  if (model.trim().toLowerCase() !== 'gemini-3.8-flash') return false
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' && !url.port &&
      ['teamorouter.com', 'api.teamorouter.com'].includes(url.hostname) &&
      ['', '/v1'].includes(url.pathname.replace(/\/+$/, ''))
  } catch { return false }
}

export const TEAMO_OPENAI_BASE = 'https://api.teamorouter.com/v1'
