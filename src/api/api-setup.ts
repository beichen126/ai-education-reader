import type { VisionCapability } from './deepseek'

export type ApiSetupInspection = {
  endpointValid: boolean
  keyPresent: boolean
  modelPresent: boolean
  visionConfigured: boolean
  readyForConnectionTest: boolean
}

export function inspectApiSetup(input: {
  baseUrl: string
  apiKey: string
  model: string
  visionCapability: VisionCapability
}): ApiSetupInspection {
  let endpointValid = false
  try {
    const url = new URL(input.baseUrl.trim())
    endpointValid = (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname
  } catch { endpointValid = false }
  const keyPresent = input.apiKey.trim().length > 0
  const modelPresent = input.model.trim().length > 0
  const visionConfigured = input.visionCapability === 'auto'
    || input.visionCapability === 'supports-image'
    || input.visionCapability === 'text-only'
  return {
    endpointValid,
    keyPresent,
    modelPresent,
    visionConfigured,
    readyForConnectionTest: endpointValid && keyPresent && modelPresent,
  }
}
