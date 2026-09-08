import { newStableId, type StableId } from '../engine/types'
import { BUILTIN_PROMPT_IDS, DEFAULT_CONVERSATION_MODE_DESCRIPTION, getBuiltinPrompt } from './prompt-registry'
import { getPromptPreferences, setBuiltinPromptHidden, setDefaultConversationModeId } from './prompt-preferences'
import { isCanonicalDefaultConversationMode } from './prompt-simplification'
import type { ArtifactPrompt, ConversationModePrompt, PromptDefinition, PromptKind } from './prompt-types'
import { allocateAvailablePromptId, getPromptRecord, deletePromptRecord, updatePromptRecordAtomic } from './prompt-store'
import { listEffectivePromptDefinitions } from './prompt-resolution'
import { resolveProtocolCanonicalRoot } from './protocol-lineage'
import { getPromptDefinitionIssues, validatePromptDefinition } from './prompt-validation'

export type PromptServiceDependencies = {
  id?: () => StableId
  now?: () => number
}

export type PromptNameWarning = {
  code: 'duplicate-name'
  name: string
  conflictingIds: StableId[]
  message: string
}

export type PromptMutationResult = {
  definition: PromptDefinition
  warnings: PromptNameWarning[]
}

export class PromptServiceError extends Error {
  readonly code: 'invalid' | 'builtin-immutable' | 'not-found' | 'id-conflict'
  constructor(code: PromptServiceError['code'], message: string) { super(message); this.name = 'PromptServiceError'; this.code = code }
}

function deps(input?: PromptServiceDependencies): Required<PromptServiceDependencies> {
  return { id: input?.id ?? newStableId, now: input?.now ?? Date.now }
}

function normalizedName(name: string): string {
  return name.trim().toLocaleLowerCase()
}

/** Name collisions are informative only; they never block a save. */
export function getPromptNameWarnings(candidate: PromptDefinition, catalog: readonly PromptDefinition[]): PromptNameWarning[] {
  const name = normalizedName(candidate.name)
  if (!name) return []
  const conflictingIds = catalog.filter((item) => item.id !== candidate.id
    && normalizedName(item.name) === name
    && !(candidate.kind === 'conversation-mode' && candidate.name === '默认' && item.id === BUILTIN_PROMPT_IDS.conversationDefault)).map((item) => item.id)
  return conflictingIds.length === 0 ? [] : [{ code: 'duplicate-name', name: candidate.name, conflictingIds, message: '已有同名提示词，但仍允许保存。' }]
}

function behaviorFingerprint(definition: PromptDefinition): string {
  switch (definition.kind) {
    case 'conversation-mode': return JSON.stringify([definition.kind, definition.systemPrompt])
    case 'artifact': return JSON.stringify([definition.kind, definition.artifactKind, definition.userPrompt, definition.protocolId ?? null])
    case 'quick-follow-up': return JSON.stringify([definition.kind, definition.userPrompt])
    case 'protocol': return JSON.stringify([definition.kind, definition.domain, definition.systemPrompt, definition.outputContract ?? null, definition.validator ?? null, definition.overridePolicy, definition.baseProtocolId ?? null])
    default: return assertNever(definition)
  }
}

/** Pure revision rule: content/contract changes bump; UI-only metadata does not. */
export function nextPromptRevision(previous: PromptDefinition | undefined, next: PromptDefinition): number {
  if (!previous) return Math.max(1, next.revision || 1)
  return behaviorFingerprint(previous) === behaviorFingerprint(next) ? previous.revision : previous.revision + 1
}

export const computeNextPromptRevision = nextPromptRevision

function assertNever(value: never): never {
  throw new Error('Unhandled prompt kind: ' + String(value))
}

function assertServiceDefinition(value: unknown): PromptDefinition {
  const definition = validatePromptDefinition(value)
  if (!definition) {
    const issues = getPromptDefinitionIssues(value)
    throw new PromptServiceError('invalid', issues.map((issue) => issue.path + ': ' + issue.message).join('; '))
  }
  return definition
}

function assertMutable(definition: PromptDefinition): void {
  if (definition.source === 'builtin') throw new PromptServiceError('builtin-immutable', '内置提示词不可直接修改，请复制或另存为。')
}

function sortCatalog(items: PromptDefinition[], preference: 'updatedAt-desc' | 'name-asc'): PromptDefinition[] {
  return items.slice().sort((a, b) => preference === 'name-asc'
    ? a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id)
    : b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

/** Merge source-code built-ins with durable custom/experimental definitions. */
export async function listPromptCatalog(kind?: PromptKind): Promise<PromptDefinition[]> {
  const [preferences, all] = await Promise.all([
    getPromptPreferences(),
    kind === 'protocol'
      ? listEffectivePromptDefinitions('protocol')
      : listEffectivePromptDefinitions(kind, { excludeKinds: ['protocol'] }),
  ])
  if (kind === 'protocol') return sortCatalog(all, preferences.sortPreference ?? 'updatedAt-desc')
  const selectedDefault = all.find((definition) => definition.kind === 'conversation-mode' && definition.id === preferences.defaultConversationModeId && definition.enabled)
    ?? all.find((definition) => definition.id === BUILTIN_PROMPT_IDS.conversationDefault)
  const visible = all.filter((definition) => {
    if (definition.kind === 'conversation-mode') return definition.id === selectedDefault?.id
    if (definition.kind === 'artifact') return definition.artifactKind === 'note' || definition.artifactKind === 'quiz'
    return true
  })
  return sortCatalog(kind ? visible.filter((definition) => definition.kind === kind) : visible, preferences.sortPreference ?? 'updatedAt-desc')
}

export async function getPromptDefinition(id: StableId): Promise<PromptDefinition | undefined> {
  const persisted = await getPromptRecord(id)
  if (persisted) return persisted
  const builtin = getBuiltinPrompt(id)
  if (!builtin) return undefined
  const preferences = await getPromptPreferences()
  return { ...builtin, enabled: builtin.enabled && !preferences.hiddenBuiltinPromptIds.includes(id) }
}

export async function savePromptDefinition(input: PromptDefinition, dependencies?: PromptServiceDependencies): Promise<PromptMutationResult> {
  const candidate = assertServiceDefinition(input)
  assertMutable(candidate)
  if (getBuiltinPrompt(candidate.id)) throw new PromptServiceError('id-conflict', '自定义提示词不能占用内置提示词 ID。')
  const d = deps(dependencies)
  const saved = await updatePromptRecordAtomic(candidate.id, (previous) => ({
    ...candidate,
    createdAt: previous?.createdAt ?? candidate.createdAt,
    updatedAt: d.now(),
    revision: nextPromptRevision(previous, candidate),
  }))
  const catalog = await listEffectivePromptDefinitions()
  return { definition: saved, warnings: getPromptNameWarnings(saved, catalog) }
}

export async function updatePromptDefinition(id: StableId, patch: Partial<PromptDefinition>, dependencies?: PromptServiceDependencies): Promise<PromptMutationResult> {
  const current = await getPromptDefinition(id)
  if (!current) throw new PromptServiceError('not-found', '提示词不存在。')
  assertMutable(current)
  const candidate = assertServiceDefinition({ ...current, ...patch })
  if (candidate.id !== current.id || candidate.kind !== current.kind || candidate.source !== current.source) throw new PromptServiceError('invalid', '不能通过更新改变提示词的 ID、kind 或 source。')
  return savePromptDefinition(candidate, dependencies)
}

/**
 * The built-in default is the editable entry presented by Prompt Manager. Its
 * user content is stored in a custom row so source-owned built-ins remain
 * immutable and old IDs stay available for history/Backup compatibility.
 */
export async function saveDefaultConversationMode(
  input: ConversationModePrompt,
  dependencies?: PromptServiceDependencies,
): Promise<PromptMutationResult> {
  if (input.kind !== 'conversation-mode') throw new PromptServiceError('invalid', '默认会话入口必须是 conversation-mode。')
  const d = deps(dependencies)
  const preferences = await getPromptPreferences()
  const current = await getPromptDefinition(preferences.defaultConversationModeId)
  if (current && isCanonicalDefaultConversationMode(current)) {
    const candidate: ConversationModePrompt = {
      ...current,
      name: '默认',
      description: DEFAULT_CONVERSATION_MODE_DESCRIPTION,
      enabled: true,
      systemPrompt: input.systemPrompt,
    }
    const result = await savePromptDefinition(candidate, dependencies)
    if (preferences.defaultConversationModeId !== result.definition.id) await setDefaultConversationModeId(result.definition.id)
    return result
  }
  const id = await allocateAvailablePromptId(d.id)
  const now = d.now()
  const candidate: ConversationModePrompt = {
    id,
    kind: 'conversation-mode',
    name: '默认',
    description: DEFAULT_CONVERSATION_MODE_DESCRIPTION,
    source: 'custom',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    systemPrompt: input.systemPrompt,
  }
  const result = await savePromptDefinition(candidate, dependencies)
  await setDefaultConversationModeId(result.definition.id)
  return result
}

export async function copyPromptDefinition(id: StableId, options: { name?: string } = {}, dependencies?: PromptServiceDependencies): Promise<PromptMutationResult> {
  const original = await getPromptDefinition(id)
  if (!original) throw new PromptServiceError('not-found', '提示词不存在。')
  const d = deps(dependencies)
  const now = d.now()
  const copyId = await allocateAvailablePromptId(d.id)
  let baseProtocolId: StableId | undefined
  if (original.kind === 'protocol') {
    const catalog = await listEffectivePromptDefinitions('protocol')
    const lineage = resolveProtocolCanonicalRoot(original, catalog)
    if ('message' in lineage) throw new PromptServiceError('invalid', '无法复制 protocol：' + lineage.message)
    baseProtocolId = lineage.canonicalId
  }
  const copy: PromptDefinition = {
    ...original,
    id: copyId,
    name: options.name?.trim() || original.name + ' 副本',
    source: original.kind === 'protocol' ? 'experimental' : 'custom',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    ...(original.kind === 'protocol' ? { overridePolicy: 'experimental' as const, baseProtocolId: baseProtocolId! } : {}),
  }
  return savePromptDefinition(copy, dependencies)
}

/** Save a run-local Artifact edit as one new catalog definition without writing raw store data. */
export async function saveAsArtifactPromptDefinition(
  id: StableId,
  options: { name?: string; userPrompt: string },
  dependencies?: PromptServiceDependencies,
): Promise<PromptMutationResult> {
  const original = await getPromptDefinition(id)
  if (!original) throw new PromptServiceError('not-found', '提示词不存在。')
  if (original.kind !== 'artifact') throw new PromptServiceError('invalid', '只有 Artifact 模板可以另存为。')
  const d = deps(dependencies)
  const now = d.now()
  const copy: ArtifactPrompt = {
    ...original,
    id: await allocateAvailablePromptId(d.id),
    name: options.name?.trim() || original.name + ' 副本',
    source: 'custom',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    userPrompt: options.userPrompt,
  }
  return savePromptDefinition(copy, dependencies)
}

export const saveAsPromptDefinition = copyPromptDefinition
export const copyPrompt = copyPromptDefinition

export async function deletePromptDefinition(id: StableId): Promise<void> {
  const builtin = getBuiltinPrompt(id)
  if (builtin) throw new PromptServiceError('builtin-immutable', '内置提示词不可删除。')
  const current = await getPromptRecord(id)
  if (!current) throw new PromptServiceError('not-found', '提示词不存在。')
  await deletePromptRecord(id)
}

export async function setPromptEnabled(id: StableId, enabled: boolean, dependencies?: PromptServiceDependencies): Promise<PromptMutationResult> {
  const current = await getPromptDefinition(id)
  if (!current) throw new PromptServiceError('not-found', '提示词不存在。')
  if (current.source === 'builtin') {
    const preferences = await setBuiltinPromptHidden(id, !enabled)
    const next = { ...current, enabled: enabled && !preferences.hiddenBuiltinPromptIds.includes(id) }
    return { definition: next, warnings: [] }
  }
  return savePromptDefinition({ ...current, enabled }, dependencies)
}

export async function setPromptSortPreference(sortPreference: 'updatedAt-desc' | 'name-asc'): Promise<void> {
  const { updatePromptPreferences } = await import('./prompt-preferences')
  await updatePromptPreferences({ sortPreference })
}
