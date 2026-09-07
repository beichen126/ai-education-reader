import type { ArtifactKind, TransformationPreset } from '../artifacts/artifact-types'
import { presetForKind, QUIZ_OUTPUT_PROTOCOL_PROMPT, TRANSFORMATION_PRESETS } from '../artifacts/artifact-prompts'
import { parseQuizDocument } from '../artifacts/artifact-validation'
import { TOC_STRUCTURE_PROMPT, TOC_TRANSCRIPTION_SYSTEM_PROMPT, parseTocJsonl, parseTocStructure } from '../documents/ai-toc'
import type { ArtifactPrompt, ConversationModePrompt, PromptDefinition, ProtocolDomain, ProtocolPrompt, PromptValidatorMetadata } from './prompt-types'

const BUILTIN_TIME = 0
const BUILTIN_REVISION = 1

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export const BUILTIN_PROMPT_IDS = {
  conversationDefault: 'builtin-conversation-default',
  conversationSocratic: 'builtin-conversation-socratic',
  conversationDeepExplanation: 'builtin-conversation-deep-explanation',
  conversationExamCoaching: 'builtin-conversation-exam-coaching',
  artifactNote: 'builtin-artifact-note',
  artifactQuiz: 'builtin-artifact-quiz',
  artifactSummary: 'builtin-artifact-summary',
  artifactStudyGuide: 'builtin-artifact-study-guide',
  artifactCustom: 'builtin-artifact-custom',
  protocolAiTocTranscription: 'builtin-protocol-ai-toc-transcription',
  protocolAiTocStructure: 'builtin-protocol-ai-toc-structure',
  protocolQuizOutput: 'builtin-protocol-quiz-output',
} as const

function base(id: string, name: string, description: string): Pick<PromptDefinition, 'id' | 'name' | 'description' | 'source' | 'enabled' | 'createdAt' | 'updatedAt' | 'revision'> {
  return { id, name, description, source: 'builtin', enabled: true, createdAt: BUILTIN_TIME, updatedAt: BUILTIN_TIME, revision: BUILTIN_REVISION }
}

export const BUILTIN_CONVERSATION_MODES: readonly ConversationModePrompt[] = [
  { ...base(BUILTIN_PROMPT_IDS.conversationDefault, '默认', '保持 1.x 的默认对话行为，不附加模式提示词。'), kind: 'conversation-mode', systemPrompt: '' },
  { ...base(BUILTIN_PROMPT_IDS.conversationSocratic, '苏格拉底式学习', '通过循序渐进的问题帮助学习者自己建立理解。'), kind: 'conversation-mode', systemPrompt: '你是一位苏格拉底式学习教练。优先通过循序渐进的问题帮助学习者澄清概念、检查自己的推理并主动形成答案；在学习者尚未尝试时，不要直接替代其完成全部推理。必要时提供简短提示，并根据学习者的回答继续调整引导。' },
  { ...base(BUILTIN_PROMPT_IDS.conversationDeepExplanation, '深入讲解', '从概念、推理、例子和易错点展开完整解释。'), kind: 'conversation-mode', systemPrompt: '你是一位擅长深入讲解的学习教师。请从概念定义、底层原理、推理过程、具体例子和常见误区展开回答，使用清晰的层次帮助学习者建立可迁移的理解；如果问题存在前置知识，请先补足必要背景。' },
  { ...base(BUILTIN_PROMPT_IDS.conversationExamCoaching, '考试辅导', '围绕考点、解题策略和自测反馈组织学习。'), kind: 'conversation-mode', systemPrompt: '你是一位考试辅导老师。请围绕考点、题型、解题步骤和易错点帮助学习者准备考试，必要时先给出分步提示或自测问题，再根据回答指出缺口；解释结论时要说明判断依据，而不是只给出答案。' },
]

export function artifactPromptIdForPreset(presetId: string): string {
  return 'builtin-artifact-' + presetId
}

function artifactPromptFromPreset(preset: TransformationPreset): ArtifactPrompt {
  const protocolId = preset.kind === 'quiz' ? BUILTIN_PROMPT_IDS.protocolQuizOutput : undefined
  return {
    ...base(artifactPromptIdForPreset(preset.id), preset.label, preset.description),
    kind: 'artifact',
    artifactKind: preset.kind,
    userPrompt: preset.defaultPrompt,
    ...(protocolId ? { protocolId } : {}),
  }
}

export const BUILTIN_ARTIFACT_PROMPTS: readonly ArtifactPrompt[] = TRANSFORMATION_PRESETS.map(artifactPromptFromPreset)

type ProtocolAdapter = {
  id: string
  name: string
  description: string
  domain: ProtocolDomain
  getSystemPrompt: () => string
  outputContract: string
  validator: PromptValidatorMetadata
}

/** Adapters point at production constants/functions; they intentionally contain no copied prompt text. */
export const PROTOCOL_METADATA_ADAPTERS: readonly ProtocolAdapter[] = [
  {
    id: BUILTIN_PROMPT_IDS.protocolAiTocTranscription,
    name: 'AI 目录 · 文字转录',
    description: '将目录页视觉内容忠实转录为可解析的 JSONL。',
    domain: 'ai-toc-transcription',
    getSystemPrompt: () => TOC_TRANSCRIPTION_SYSTEM_PROMPT,
    outputContract: 'JSONL rows validated by parseTocJsonl()',
    validator: { name: 'parseTocJsonl', description: '严格解析并校验目录文字转录 JSONL。' },
  },
  {
    id: BUILTIN_PROMPT_IDS.protocolAiTocStructure,
    name: 'AI 目录 · 结构分析',
    description: '根据已转录目录行推断连续的绝对层级。',
    domain: 'ai-toc-structure',
    getSystemPrompt: () => TOC_STRUCTURE_PROMPT,
    outputContract: 'compact JSON levels validated by parseTocStructure()',
    validator: { name: 'parseTocStructure', description: '严格校验目录层级数量、正整数与层级跳变。' },
  },
  {
    id: BUILTIN_PROMPT_IDS.protocolQuizOutput,
    name: 'Quiz · 输出协议',
    description: '约束题目生成结果为可验证的 QuizDocument。',
    domain: 'quiz-output',
    getSystemPrompt: () => QUIZ_OUTPUT_PROTOCOL_PROMPT,
    outputContract: 'QuizDocument validated by parseQuizDocument()',
    validator: { name: 'parseQuizDocument', description: '解析并严格校验 QuizDocument 及答案索引。' },
  },
]

function protocolPromptFromAdapter(adapter: ProtocolAdapter): ProtocolPrompt {
  return {
    ...base(adapter.id, adapter.name, adapter.description),
    kind: 'protocol',
    domain: adapter.domain,
    systemPrompt: adapter.getSystemPrompt(),
    outputContract: adapter.outputContract,
    validator: { ...adapter.validator },
    overridePolicy: 'read-only',
  }
}

export const BUILTIN_PROTOCOL_PROMPTS: readonly ProtocolPrompt[] = PROTOCOL_METADATA_ADAPTERS.map(protocolPromptFromAdapter)

export const BUILTIN_PROMPT_REGISTRY: readonly PromptDefinition[] = Object.freeze([
  ...BUILTIN_CONVERSATION_MODES,
  ...BUILTIN_ARTIFACT_PROMPTS,
  ...BUILTIN_PROTOCOL_PROMPTS,
].map((definition) => deepFreeze(definition)))

export const BUILTIN_PROMPTS = BUILTIN_PROMPT_REGISTRY

Object.freeze(BUILTIN_CONVERSATION_MODES)
Object.freeze(BUILTIN_ARTIFACT_PROMPTS)
Object.freeze(BUILTIN_PROTOCOL_PROMPTS)

/** Public callers receive a detached definition, including nested validator metadata. */
export function clonePromptDefinition(definition: PromptDefinition): PromptDefinition {
  switch (definition.kind) {
    case 'conversation-mode': return { ...definition }
    case 'artifact': return { ...definition }
    case 'quick-follow-up': return { ...definition }
    case 'protocol': return { ...definition, ...(definition.validator ? { validator: { ...definition.validator } } : {}) }
    default: return assertNever(definition)
  }
}

export function getBuiltinPrompt(id: string): PromptDefinition | undefined {
  const definition = BUILTIN_PROMPT_REGISTRY.find((item) => item.id === id)
  return definition ? clonePromptDefinition(definition) : undefined
}

export function listBuiltinPrompts(kind?: PromptDefinition['kind']): PromptDefinition[] {
  return BUILTIN_PROMPT_REGISTRY.filter((definition) => !kind || definition.kind === kind).map(clonePromptDefinition)
}

export function getBuiltinProtocol(domain: ProtocolDomain): ProtocolPrompt | undefined {
  const definition = BUILTIN_PROTOCOL_PROMPTS.find((item) => item.domain === domain)
  return definition ? clonePromptDefinition(definition) as ProtocolPrompt : undefined
}

export function getBuiltinArtifactPrompt(kind: ArtifactKind): ArtifactPrompt | undefined {
  const definition = BUILTIN_ARTIFACT_PROMPTS.find((item) => item.artifactKind === kind)
  return definition ? clonePromptDefinition(definition) as ArtifactPrompt : undefined
}

function assertNever(value: never): never {
  throw new Error('Unhandled prompt kind: ' + String(value))
}

// Keep these imports observable to the adapter contract without executing the validators.
export const BUILTIN_PROTOCOL_VALIDATOR_NAMES = {
  aiTocTranscription: parseTocJsonl.name || 'parseTocJsonl',
  aiTocStructure: parseTocStructure.name || 'parseTocStructure',
  quizOutput: parseQuizDocument.name || 'parseQuizDocument',
} as const
