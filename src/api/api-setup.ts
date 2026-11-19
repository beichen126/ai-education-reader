export type ApiSetupInspection = {
  endpointValid: boolean
  keyPresent: boolean
  modelPresent: boolean
  readyForConnectionTest: boolean
}

export function inspectApiSetup(input: {
  baseUrl: string
  apiKey: string
  model: string
}): ApiSetupInspection {
  let endpointValid = false
  try {
    const url = new URL(input.baseUrl.trim())
    endpointValid = (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname
  } catch { endpointValid = false }
  const keyPresent = input.apiKey.trim().length > 0
  const modelPresent = input.model.trim().length > 0
  return {
    endpointValid,
    keyPresent,
    modelPresent,
    readyForConnectionTest: endpointValid && keyPresent && modelPresent,
  }
}
