import 'fake-indexeddb/auto'
import { idbClearAll } from '../src/storage/idb.ts'
import { capturePromptSnapshot, resolveCurrentProtocolResult } from '../src/prompts/prompt-resolution.ts'
import { compileMachineProtocolMessages } from '../src/prompts/protocol-request.ts'
import { copyPromptDefinition, updatePromptDefinition } from '../src/prompts/prompt-service.ts'
import { setActiveProtocolOverride } from '../src/prompts/prompt-preferences.ts'
import { BUILTIN_PROMPT_IDS, getBuiltinProtocol } from '../src/prompts/prompt-registry.ts'
import { parseTocJsonl } from '../src/documents/ai-toc.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

await idbClearAll()
const canonical = getBuiltinProtocol('ai-toc-transcription')!
const canonicalSnapshot = capturePromptSnapshot(canonical, 100)
assert(canonicalSnapshot.kind === 'protocol' && canonicalSnapshot.protocolDomain === 'ai-toc-transcription', 'canonical AI TOC protocol snapshot carries its machine domain')

const canonicalMessages = await compileMachineProtocolMessages({
  domain: 'ai-toc-transcription',
  protocol: canonicalSnapshot,
  content: '【图片 1 / 1 · PDF physical page 7】',
  images: [{ id: 'page-7', dataUrl: 'data:image/png;base64,AA==' }],
})
assert(canonicalMessages[0]?.role === 'system' && canonicalMessages[0].content === canonical.systemPrompt, 'AI TOC production compiler emits the canonical system protocol')
assert(canonicalMessages[1]?.role === 'user' && Array.isArray(canonicalMessages[1].content) && canonicalMessages[1].content.some((part) => part.type === 'image_url'), 'machine protocol compiler preserves the PDF image request')

const copied = await copyPromptDefinition(BUILTIN_PROMPT_IDS.protocolAiTocTranscription, { name: '实验转录协议' }, { id: () => 'experimental-toc', now: () => 200 })
assert(copied.definition.kind === 'protocol' && copied.definition.source === 'experimental', 'copying a read-only protocol creates an experimental definition')
if (copied.definition.kind !== 'protocol') throw new Error('protocol copy did not produce a protocol')
const edited = await updatePromptDefinition(copied.definition.id, { systemPrompt: '实验协议：只输出实验 JSONL。' }, { now: () => 201 })
assert(edited.definition.kind === 'protocol' && edited.definition.revision === 2, 'editing experimental protocol content increments revision')
await setActiveProtocolOverride('ai-toc-transcription', copied.definition.id)
const resolved = await resolveCurrentProtocolResult('ai-toc-transcription', 300)
assert(resolved.usedOverride && resolved.snapshot?.content === '实验协议：只输出实验 JSONL。', 'active override resolution selects the matching experimental snapshot')
if (!resolved.snapshot) throw new Error('expected resolved protocol snapshot')
const overrideMessages = await compileMachineProtocolMessages({ domain: 'ai-toc-transcription', protocol: resolved.snapshot, content: 'rows' })
assert(overrideMessages[0]?.content === '实验协议：只输出实验 JSONL。', 'AI TOC request really sends the active override prompt')

const frozen = resolved.snapshot
await updatePromptDefinition(copied.definition.id, { systemPrompt: '后续编辑不应漂移到已开始的请求。' })
const frozenMessages = await compileMachineProtocolMessages({ domain: 'ai-toc-transcription', protocol: frozen, content: 'rows' })
assert(frozenMessages[0]?.content === '实验协议：只输出实验 JSONL。', 'request compilation remains frozen after a later catalog edit')

const malformed = parseTocJsonl('not-json')
assert(!malformed.ok, 'canonical TOC parser still rejects malformed output independently of prompt metadata')
await setActiveProtocolOverride('ai-toc-transcription', undefined)
const restored = await resolveCurrentProtocolResult('ai-toc-transcription', 400)
assert(!restored.usedOverride && restored.snapshot?.profileId === BUILTIN_PROMPT_IDS.protocolAiTocTranscription, 'restore canonical clears only the active mapping')

let mismatchRejected = false
try {
  await compileMachineProtocolMessages({ domain: 'ai-toc-transcription', protocol: { ...canonicalSnapshot, protocolDomain: 'ai-toc-structure' }, content: 'rows' })
} catch { mismatchRejected = true }
assert(mismatchRejected, 'protocol subdomain mismatch is rejected before transport')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
