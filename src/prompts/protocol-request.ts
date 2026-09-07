import type { ApiChatMessage } from '../api/deepseek'
import { DEFAULT_PROVIDER_CAPABILITIES } from '../api/provider-capabilities'
import type { Message, StableId } from '../engine/types'
import { compileProtocolRequest } from './prompt-compiler'
import type { ProtocolPromptSnapshot } from './prompt-types'

export type MachineProtocolDomain = 'ai-toc-transcription' | 'ai-toc-structure'

/** Compile one frozen machine-protocol snapshot without rereading the catalog. */
export async function compileMachineProtocolMessages(input: {
  domain: MachineProtocolDomain
  protocol: ProtocolPromptSnapshot
  content: string
  images?: { id: StableId; dataUrl: string }[]
}): Promise<ApiChatMessage[]> {
  const images = input.images ?? []
  const message: Message = {
    id: 'machine-protocol-input',
    role: 'user',
    content: input.content,
    images: images.map((image) => image.id),
    createdAt: 0,
    updatedAt: 0,
  }
  const dataUrls = new Map(images.map((image) => [image.id, image.dataUrl]))
  const compiled = await compileProtocolRequest({
    domain: input.domain,
    inputMessages: [message],
    protocolPrompt: input.protocol,
    systemMessagePolicy: 'auto',
    providerCapabilities: DEFAULT_PROVIDER_CAPABILITIES,
  }, { toDataUrl: async (id) => {
    const dataUrl = dataUrls.get(id)
    if (!dataUrl) throw new Error('missing machine protocol image ' + id)
    return dataUrl
  } })
  return compiled.messages
}
