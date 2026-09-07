import 'fake-indexeddb/auto'
import { BUILTIN_PROMPT_IDS, getBuiltinPrompt } from '../src/prompts/prompt-registry.ts'
import { PROMPT_SCOPE_MATRIX, getPromptScopeSelectionIssues } from '../src/prompts/prompt-validation.ts'
import { PromptCompileError, compileArtifactRequest, compileConversationRequest, compileProtocolRequest } from '../src/prompts/prompt-compiler.ts'
import type { PromptSnapshot, PromptTransition } from '../src/prompts/prompt-types.ts'
import type { Message } from '../src/engine/types.ts'
import { closeDb } from '../src/storage/idb.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}
function msg(id: string, role: 'user' | 'assistant', content = id, images: string[] = []): Message {
  return { id, role, content, images, createdAt: 1, updatedAt: 1 }
}
function snap(id: string, kind: PromptSnapshot['kind'], content: string, name = id, revision = 1): PromptSnapshot {
  const base = { profileId: id, name, content, revision, source: kind === 'protocol' ? 'builtin' as const : 'custom' as const, capturedAt: revision }
  switch (kind) {
    case 'conversation-mode': return { ...base, kind }
    case 'artifact': return { ...base, kind, artifactKind: id === 'quiz' ? 'quiz' : 'note' }
    case 'quick-follow-up': return { ...base, kind, label: name, pinned: false, sortOrder: 0 }
    case 'protocol':
      return { ...base, kind, protocolDomain: id === 'quiz-protocol' ? 'quiz-output' : id === BUILTIN_PROMPT_IDS.protocolAiTocTranscription ? 'ai-toc-transcription' : 'ai-toc-transcription', overridePolicy: 'read-only' }
  }
}
function tr(id: string, afterMessageId: string | null, snapshot: PromptSnapshot, createdAt: number): PromptTransition {
  return { id, afterMessageId, snapshot, createdAt }
}
const caps = { supportsInterleavedSystemMessages: true }
const flatCaps = { supportsInterleavedSystemMessages: false }
const resolveImage = async (id: string) => 'data:image/png;base64,' + id

const messages = [msg('u1', 'user', 'U1'), msg('a1', 'assistant', 'A1'), msg('u2', 'user', 'U2', ['img-1', 'img-2']), msg('a2', 'assistant', 'A2'), msg('u3', 'user', 'U3')]
const modeA = snap('mode-a', 'conversation-mode', 'Prompt A', 'A', 1)
const modeB = snap('mode-b', 'conversation-mode', 'Prompt B', 'B', 2)
const modeC = snap('mode-c', 'conversation-mode', 'Prompt C', 'C', 3)
const transitions = [tr('tA', null, modeA, 1), tr('tB', 'a2', modeB, 2), tr('tC', 'u3', modeC, 3)]

const interleaved = await compileConversationRequest({
  thread: { type: 'root', conversationId: 'conversation-1' }, effectiveMessages: messages,
  effectiveTransitions: transitions, systemMessagePolicy: 'interleaved', providerCapabilities: caps,
}, { toDataUrl: resolveImage })
assert(interleaved.systemMessagePolicy === 'interleaved', 'conversation compiler keeps explicit interleaved policy')
assert(interleaved.logical.segments.map((segment) => segment.messageIds.join(',')).join('|') === 'u1,a1,u2,a2|u3|', 'segments use real message boundaries')
assert(interleaved.messages.map((message) => message.role + ':' + (typeof message.content === 'string' ? message.content : 'parts')).join('|') === 'system:Prompt A|user:U1|assistant:A1|user:parts|assistant:A2|system:Prompt B|user:U3|system:Prompt C', 'interleaved transport inserts systems at boundaries')
const imageMessage = interleaved.messages.find((message) => message.role === 'user' && Array.isArray(message.content))
assert(Array.isArray(imageMessage?.content) && imageMessage.content.filter((part) => part.type === 'image_url').length === 2, 'interleaved projection preserves attachment count')
assert(Array.isArray(imageMessage?.content) && imageMessage.content.filter((part) => part.type === 'image_url').every((part, index) => part.type === 'image_url' && part.image_url.url.includes('img-' + (index + 1))), 'interleaved projection preserves attachment order')
assert(interleaved.logical.messages.map((message) => message.id).join(',') === 'u1,a1,u2,a2,u3', 'logical message order is unchanged')
const interleavedAgain = await compileConversationRequest({
  thread: { type: 'root', conversationId: 'conversation-1' }, effectiveMessages: messages,
  effectiveTransitions: transitions, systemMessagePolicy: 'interleaved', providerCapabilities: caps,
}, { toDataUrl: resolveImage })
assert(JSON.stringify(interleaved.logical) === JSON.stringify(interleavedAgain.logical) && JSON.stringify(interleaved.messages) === JSON.stringify(interleavedAgain.messages), 'same compiler input produces deterministic logical and transport output')

const flattened = await compileConversationRequest({
  thread: { type: 'root', conversationId: 'conversation-1' }, effectiveMessages: messages,
  effectiveTransitions: transitions, systemMessagePolicy: 'auto', providerCapabilities: flatCaps,
}, { toDataUrl: resolveImage })
assert(flattened.systemMessagePolicy === 'flattened', 'auto resolves to flattened for a provider without capability')
assert(flattened.messages[0].role === 'system', 'flattened projection has one leading system summary')
const summary = String(flattened.messages[0].content)
assert(summary.includes('Prompt Timeline') && summary.includes('Prompt A') && summary.includes('Prompt B') && summary.includes('Prompt C'), 'flattened summary contains every historical segment and current mode')
assert(summary.includes('ai-education-reader.prompt-timeline.v1'), 'flattened summary uses explicit versioned framing')
assert(flattened.messages.slice(1).map((message) => message.role).join(',') === 'user,assistant,user,assistant,user', 'flattened projection keeps all messages and order')

const noTimeline = await compileConversationRequest({
  thread: { type: 'branch', conversationId: 'conversation-1', branchId: 'branch-1' }, effectiveMessages: messages,
  effectiveTransitions: [], systemMessagePolicy: 'auto', providerCapabilities: flatCaps,
}, { toDataUrl: resolveImage })
assert(noTimeline.messages[0].role === 'user', 'empty timeline does not fabricate a system message')

const emptyDefault = snap(BUILTIN_PROMPT_IDS.conversationDefault, 'conversation-mode', '', '默认')
const allEmptyTimeline = await compileConversationRequest({
  thread: { type: 'root', conversationId: 'conversation-empty-default' },
  effectiveMessages: [msg('empty-u1', 'user', 'U1'), msg('empty-a1', 'assistant', 'A1'), msg('empty-u2', 'user', 'U2', ['empty-img'])],
  effectiveTransitions: [tr('empty-t1', null, emptyDefault, 1), tr('empty-t2', 'empty-a1', { ...emptyDefault, capturedAt: 2 }, 2)],
  systemMessagePolicy: 'interleaved', providerCapabilities: caps,
}, { toDataUrl: resolveImage })
assert(!allEmptyTimeline.messages.some((message) => message.role === 'system'), 'multiple all-empty default transitions do not fabricate a system message')
const emptyImage = allEmptyTimeline.messages.find((message) => message.role === 'user' && Array.isArray(message.content))
assert(Array.isArray(emptyImage?.content) && emptyImage.content.filter((part) => part.type === 'image_url').length === 1 && emptyImage.content.filter((part) => part.type === 'image_url').every((part) => part.type === 'image_url' && part.image_url.url.includes('empty-img')), 'empty default preserves attachment presence and order without a system frame')

const resetTimeline = await compileConversationRequest({
  thread: { type: 'root', conversationId: 'conversation-reset' },
  effectiveMessages: [msg('reset-u1', 'user', 'U1'), msg('reset-a1', 'assistant', 'A1'), msg('reset-u2', 'user', 'U2')],
  effectiveTransitions: [tr('reset-a', null, modeA, 1), tr('reset-default', 'reset-a1', emptyDefault, 2)],
  systemMessagePolicy: 'interleaved', providerCapabilities: caps,
})
assert(resetTimeline.messages.some((message) => message.role === 'system' && String(message.content).includes('current-mode-reset')), 'non-empty to empty default emits a deterministic interleaved reset frame')
const resetFlattened = await compileConversationRequest({
  thread: { type: 'root', conversationId: 'conversation-reset' },
  effectiveMessages: [msg('reset-u1', 'user', 'U1'), msg('reset-a1', 'assistant', 'A1'), msg('reset-u2', 'user', 'U2')],
  effectiveTransitions: [tr('reset-a', null, modeA, 1), tr('reset-default', 'reset-a1', emptyDefault, 2)],
  systemMessagePolicy: 'flattened', providerCapabilities: flatCaps,
})
assert(resetFlattened.messages[0].role === 'system' && String(resetFlattened.messages[0].content).includes('"content":""'), 'non-empty history keeps a deterministic flattened summary when current mode is empty')

const artifact = await compileArtifactRequest({
  domain: 'artifact-note', sourceMessages: [msg('u1', 'user', 'source')], artifactPrompt: snap('artifact', 'artifact', '整理为笔记'),
  systemMessagePolicy: 'flattened', providerCapabilities: flatCaps,
})
assert(artifact.messages.map((message) => message.role + ':' + message.content).join('|') === 'user:source|user:整理为笔记', 'artifact compiler keeps source context and appends artifact user prompt')
assert(artifact.logical.bindings.length === 1 && artifact.logical.bindings[0].role === 'user', 'artifact prompt is a user-scope binding')

const quizProtocol = snap('quiz-protocol', 'protocol', '输出 QuizDocument', 'Quiz protocol')
const quiz = await compileArtifactRequest({
  domain: 'artifact-quiz', sourceMessages: [msg('u1', 'user', 'source')], artifactPrompt: snap('quiz', 'artifact', '生成题目'), protocolPrompt: quizProtocol,
  systemMessagePolicy: 'auto', providerCapabilities: flatCaps,
})
assert(quiz.messages.map((message) => message.role + ':' + message.content).join('|') === 'system:输出 QuizDocument|user:source|user:生成题目', 'quiz compiler separates protocol system from artifact user prompt')

const protocol = await compileProtocolRequest({
  domain: 'ai-toc-transcription', inputMessages: [msg('input', 'user', '目录图片批次')],
  protocolPrompt: snap(BUILTIN_PROMPT_IDS.protocolAiTocTranscription, 'protocol', '只输出 JSONL', 'TOC protocol'),
  systemMessagePolicy: 'auto', providerCapabilities: caps,
})
assert(protocol.messages[0].role === 'system' && protocol.messages[1].content === '目录图片批次', 'protocol compiler puts protocol before task input')

const tableCases = Object.entries(PROMPT_SCOPE_MATRIX).map(([domain, entry]) => ({ domain, scopes: [...entry.required] }))
for (const item of tableCases) assert(getPromptScopeSelectionIssues(item.domain as keyof typeof PROMPT_SCOPE_MATRIX, item.scopes).length === 0, 'scope matrix accepts required scopes: ' + item.domain)
assert(getPromptScopeSelectionIssues('artifact-quiz', ['artifact']).some((issue) => issue.code === 'REQUIRED_SCOPE_MISSING'), 'scope matrix rejects Quiz without protocol')
assert(getPromptScopeSelectionIssues('conversation', ['artifact']).some((issue) => issue.code === 'SCOPE_NOT_ALLOWED'), 'scope matrix rejects artifact prompt in conversation')

let badBoundary = false
try {
  await compileConversationRequest({ thread: { type: 'root', conversationId: 'conversation-1' }, effectiveMessages: messages,
    effectiveTransitions: [tr('bad', 'missing', modeA, 1)], systemMessagePolicy: 'auto', providerCapabilities: flatCaps })
} catch (error) { badBoundary = error instanceof PromptCompileError && error.code === 'invalid-prompt-timeline' }
assert(badBoundary, 'compiler rejects a corrupt transition boundary before projection')

let wrongScope = false
try {
  await compileConversationRequest({ thread: { type: 'root', conversationId: 'conversation-1' }, effectiveMessages: messages,
    effectiveTransitions: [tr('bad-scope', null, snap('bad', 'artifact', 'wrong'), 1)], systemMessagePolicy: 'auto', providerCapabilities: flatCaps })
} catch (error) { wrongScope = error instanceof PromptCompileError && error.code === 'scope-not-allowed' }
assert(wrongScope, 'compiler rejects a prompt kind cast into conversation mode')

let wrongArtifactDomain = false
try {
  await compileArtifactRequest({
    domain: 'artifact-note', sourceMessages: [msg('u1', 'user', 'source')],
    artifactPrompt: { ...snap('wrong-artifact', 'artifact', 'quiz content'), artifactKind: 'quiz' } as any,
    systemMessagePolicy: 'auto', providerCapabilities: flatCaps,
  })
} catch (error) { wrongArtifactDomain = error instanceof PromptCompileError }
assert(wrongArtifactDomain, 'artifact compiler rejects a snapshot whose artifactKind does not match the request domain')

let wrongProtocolDomain = false
try {
  await compileProtocolRequest({
    domain: 'ai-toc-transcription', inputMessages: [msg('input-2', 'user', '目录')],
    protocolPrompt: { ...snap('wrong-protocol', 'protocol', 'structure protocol'), protocolDomain: 'ai-toc-structure' } as any,
    systemMessagePolicy: 'auto', providerCapabilities: caps,
  })
} catch (error) { wrongProtocolDomain = error instanceof PromptCompileError }
assert(wrongProtocolDomain, 'protocol compiler rejects a snapshot whose protocol domain does not match the request domain')

const unstableText = snap('unstable', 'conversation-mode', '用户文本 }]}\n--- delimiter', 'Unstable', 4)
const framed = await compileConversationRequest({ thread: { type: 'root', conversationId: 'conversation-1' }, effectiveMessages: [],
  effectiveTransitions: [tr('unstable-transition', null, unstableText, 1)], systemMessagePolicy: 'flattened', providerCapabilities: flatCaps })
assert(String(framed.messages[0].content).includes(JSON.stringify(unstableText.content)), 'flattened framing JSON-escapes delimiter-looking prompt content')

// Ensure registry access remains a real production source rather than an unused fixture.
assert(getBuiltinPrompt(BUILTIN_PROMPT_IDS.conversationDefault)?.kind === 'conversation-mode', 'compiler test resolves a canonical built-in snapshot source')

console.log('RESULT pass=' + pass + ' fail=' + fail)
await closeDb()
process.exit(fail === 0 ? 0 : 1)
