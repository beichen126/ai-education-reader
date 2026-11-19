import type { Settings } from '../engine/settings-store'
import type { RejectedSend } from '../engine/send-outcome'
import { errorKindLabel } from './deepseek'

export function providerPreflight(settings: Settings): RejectedSend | undefined {
  if (!settings.apiKey) return { kind: 'rejected', code: 'no-api-key', message: errorKindLabel('no-api-key') }
}
