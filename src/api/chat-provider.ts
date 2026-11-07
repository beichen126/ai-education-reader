import { GENUI_PROMPT } from '../genui/schema'
import type { Settings } from '../engine/settings-store'
import type { RejectedSend } from '../engine/send-outcome'
import { errorKindLabel, streamTextChat, type StreamTextChatArgs } from './deepseek'
import { getLocalStatus, LocalProviderError, streamLocalChat } from './openai-local'
import { tx } from '../engine/locale'

// Existing configurations remain on the original transport; no model-name inference.
export async function providerPreflight(settings: Settings, signal?: AbortSignal): Promise<RejectedSend | undefined> {
  if (settings.chatProvider !== 'openai-local') return settings.apiKey ? undefined : { kind: 'rejected', code: 'no-api-key', message: errorKindLabel('no-api-key') }
  try {
    const status = await getLocalStatus(signal, 15000)
    if (status.errorCode) throw new LocalProviderError(status.errorCode)
    if (status.login === 'pending') throw new LocalProviderError('authorization_pending')
    if (status.auth !== 'authorized') throw new LocalProviderError('authorization_not_verified')
    if (!status.ready) throw new LocalProviderError('model_discovery_failed')
    if (!settings.openaiLocalModel || !status.models.includes(settings.openaiLocalModel)) throw new LocalProviderError('model_unavailable')
  } catch (error) { return { kind: 'rejected', code: error instanceof LocalProviderError ? error.code : 'local-unavailable', message: error instanceof LocalProviderError ? error.message : tx('本机服务不可用。', 'Local service unavailable.') } }
}
export function streamProviderChat(settings: Settings, args: StreamTextChatArgs) {
  if (!args.jsonObject) {
    const messages = args.messages.slice()
    const first = messages[0]
    if (first?.role === 'system' && typeof first.content === 'string') messages[0] = { ...first, content: first.content + '\n\n' + GENUI_PROMPT }
    else messages.unshift({ role: 'system', content: GENUI_PROMPT })
    args = { ...args, messages }
  }
  return settings.chatProvider === 'openai-local'
    ? streamLocalChat({ ...args, model: settings.openaiLocalModel || '' })
    : streamTextChat(args)
}
