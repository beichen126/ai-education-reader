import type {
  PromptDefinition,
  PromptKind,
  PromptRequestDomain,
  PromptSnapshot,
  PromptTransition,
  PromptScope,
  PromptScopeMatrix,
} from './prompt-types'

const PROMPT_KINDS = new Set<PromptKind>(['conversation-mode', 'artifact', 'quick-follow-up', 'protocol'])
const PROMPT_SOURCES = new Set(['builtin', 'custom', 'experimental'])
const ARTIFACT_KINDS = new Set(['note', 'quiz', 'summary', 'study-guide', 'custom'])
const PROTOCOL_POLICIES = new Set(['read-only', 'experimental'])
const SNAPSHOT_SOURCES = new Set(['builtin', 'custom', 'legacy', 'experimental'])

export type PromptValidationIssue = {
  code: string
  path: string
  message: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function add(issues: PromptValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message })
}

function validateBase(value: Record<string, unknown>, issues: PromptValidationIssue[]): void {
  if (!isNonEmptyString(value.id)) add(issues, 'INVALID_ID', 'id', 'id must be a non-empty string')
  if (typeof value.name !== 'string') add(issues, 'INVALID_NAME', 'name', 'name must be a string')
  if (typeof value.description !== 'string') add(issues, 'INVALID_DESCRIPTION', 'description', 'description must be a string')
  if (typeof value.source !== 'string' || !PROMPT_SOURCES.has(value.source)) add(issues, 'INVALID_SOURCE', 'source', 'source is not a supported prompt source')
  if (typeof value.enabled !== 'boolean') add(issues, 'INVALID_ENABLED', 'enabled', 'enabled must be boolean')
  if (!isFiniteNumber(value.createdAt)) add(issues, 'INVALID_CREATED_AT', 'createdAt', 'createdAt must be finite')
  if (!isFiniteNumber(value.updatedAt)) add(issues, 'INVALID_UPDATED_AT', 'updatedAt', 'updatedAt must be finite')
  if (!isFiniteNumber(value.revision) || !Number.isInteger(value.revision) || value.revision < 1) add(issues, 'INVALID_REVISION', 'revision', 'revision must be a positive integer')
}

/** Return every structural issue without mutating the supplied value. */
export function getPromptDefinitionIssues(value: unknown): PromptValidationIssue[] {
  const issues: PromptValidationIssue[] = []
  if (!isObject(value)) return [{ code: 'NOT_OBJECT', path: '', message: 'prompt definition must be an object' }]
  validateBase(value, issues)
  if (typeof value.kind !== 'string' || !PROMPT_KINDS.has(value.kind as PromptKind)) {
    add(issues, 'INVALID_KIND', 'kind', 'kind is not a supported prompt kind')
    return issues
  }

  switch (value.kind) {
    case 'conversation-mode':
      if (typeof value.systemPrompt !== 'string') add(issues, 'INVALID_SYSTEM_PROMPT', 'systemPrompt', 'systemPrompt must be a string')
      break
    case 'artifact':
      if (typeof value.artifactKind !== 'string' || !ARTIFACT_KINDS.has(value.artifactKind)) add(issues, 'INVALID_ARTIFACT_KIND', 'artifactKind', 'artifactKind is not supported')
      if (typeof value.userPrompt !== 'string') add(issues, 'INVALID_USER_PROMPT', 'userPrompt', 'userPrompt must be a string')
      if (value.protocolId !== undefined && !isNonEmptyString(value.protocolId)) add(issues, 'INVALID_PROTOCOL_ID', 'protocolId', 'protocolId must be a non-empty string when present')
      break
    case 'quick-follow-up':
      if (!isNonEmptyString(value.label)) add(issues, 'INVALID_LABEL', 'label', 'label must be a non-empty string')
      if (typeof value.userPrompt !== 'string') add(issues, 'INVALID_USER_PROMPT', 'userPrompt', 'userPrompt must be a string')
      if (typeof value.pinned !== 'boolean') add(issues, 'INVALID_PINNED', 'pinned', 'pinned must be boolean')
      if (!isFiniteNumber(value.sortOrder) || !Number.isInteger(value.sortOrder) || value.sortOrder < 0) add(issues, 'INVALID_SORT_ORDER', 'sortOrder', 'sortOrder must be a non-negative integer')
      break
    case 'protocol':
      if (!isNonEmptyString(value.domain)) add(issues, 'INVALID_DOMAIN', 'domain', 'domain must be a non-empty string')
      if (typeof value.systemPrompt !== 'string') add(issues, 'INVALID_SYSTEM_PROMPT', 'systemPrompt', 'systemPrompt must be a string')
      if (value.outputContract !== undefined && typeof value.outputContract !== 'string') add(issues, 'INVALID_OUTPUT_CONTRACT', 'outputContract', 'outputContract must be a string when present')
      if (value.validator !== undefined) {
        if (!isObject(value.validator) || !isNonEmptyString(value.validator.name) || typeof value.validator.description !== 'string') add(issues, 'INVALID_VALIDATOR', 'validator', 'validator metadata is invalid')
      }
      if (typeof value.overridePolicy !== 'string' || !PROTOCOL_POLICIES.has(value.overridePolicy)) add(issues, 'INVALID_OVERRIDE_POLICY', 'overridePolicy', 'overridePolicy is not supported')
      if (value.baseProtocolId !== undefined && !isNonEmptyString(value.baseProtocolId)) add(issues, 'INVALID_BASE_PROTOCOL_ID', 'baseProtocolId', 'baseProtocolId must be a non-empty string when present')
      break
    default:
      return assertNever(value.kind as never)
  }
  return issues
}

/** Validate and return a typed definition, or null for untrusted input. */
export function validatePromptDefinition(value: unknown): PromptDefinition | null {
  return getPromptDefinitionIssues(value).length === 0 ? value as PromptDefinition : null
}

export function isPromptDefinition(value: unknown): value is PromptDefinition {
  return validatePromptDefinition(value) !== null
}

export const isValidPromptDefinition = isPromptDefinition

export function assertPromptDefinition(value: unknown): PromptDefinition {
  const definition = validatePromptDefinition(value)
  if (!definition) throw new Error(getPromptDefinitionIssues(value).map((issue) => issue.path + ': ' + issue.message).join('; '))
  return definition
}

function assertNever(value: never): never {
  throw new Error('Unhandled prompt kind: ' + String(value))
}

/** Return the exact content that belongs to a definition's own scope. */
export function promptContent(definition: PromptDefinition): string {
  switch (definition.kind) {
    case 'conversation-mode': return definition.systemPrompt
    case 'artifact': return definition.userPrompt
    case 'quick-follow-up': return definition.userPrompt
    case 'protocol': return definition.systemPrompt
    default: return assertNever(definition)
  }
}

export function promptScopeOfKind(kind: PromptKind): PromptScope {
  switch (kind) {
    case 'conversation-mode': return 'conversation-mode'
    case 'artifact': return 'artifact'
    case 'quick-follow-up': return 'quick-follow-up'
    case 'protocol': return 'protocol'
    default: return assertNever(kind)
  }
}

export const PROMPT_SCOPE_MATRIX: PromptScopeMatrix = {
  conversation: { allowed: ['conversation-mode'], required: ['conversation-mode'] },
  'conversation-quick-follow-up': { allowed: ['conversation-mode', 'quick-follow-up'], required: ['conversation-mode', 'quick-follow-up'] },
  'artifact-note': { allowed: ['artifact', 'protocol'], required: ['artifact'] },
  'artifact-quiz': { allowed: ['artifact', 'protocol'], required: ['artifact', 'protocol'] },
  'artifact-summary': { allowed: ['artifact', 'protocol'], required: ['artifact'] },
  'artifact-study-guide': { allowed: ['artifact', 'protocol'], required: ['artifact'] },
  'artifact-custom': { allowed: ['artifact', 'protocol'], required: ['artifact'] },
  'ai-toc-transcription': { allowed: ['protocol'], required: ['protocol'] },
  'ai-toc-structure': { allowed: ['protocol'], required: ['protocol'] },
}

export type PromptScopeIssue = {
  code: string
  domain: PromptRequestDomain
  scope?: PromptScope
  message: string
}

/** Validate the table itself so request-domain policy cannot silently drift. */
export function getPromptScopeMatrixIssues(matrix: PromptScopeMatrix = PROMPT_SCOPE_MATRIX): PromptScopeIssue[] {
  const issues: PromptScopeIssue[] = []
  const domains = Object.keys(PROMPT_SCOPE_MATRIX) as PromptRequestDomain[]
  for (const domain of domains) {
    const entry = matrix[domain]
    if (!entry) {
      issues.push({ code: 'MISSING_DOMAIN', domain, message: 'scope matrix is missing ' + domain })
      continue
    }
    const allowed = new Set(entry.allowed)
    const required = new Set(entry.required)
    for (const scope of required) {
      if (!allowed.has(scope)) issues.push({ code: 'REQUIRED_NOT_ALLOWED', domain, scope, message: 'required scope is not allowed' })
    }
    for (const scope of entry.allowed) {
      if (!['conversation-mode', 'artifact', 'quick-follow-up', 'protocol'].includes(scope)) issues.push({ code: 'UNKNOWN_SCOPE', domain, scope, message: 'unknown scope in matrix' })
    }
  }
  return issues
}

export function validatePromptScopeMatrix(matrix: PromptScopeMatrix = PROMPT_SCOPE_MATRIX): boolean {
  return getPromptScopeMatrixIssues(matrix).length === 0
}

export function getPromptScopeSelectionIssues(domain: PromptRequestDomain, scopes: readonly PromptScope[]): PromptScopeIssue[] {
  const entry = PROMPT_SCOPE_MATRIX[domain]
  if (!entry) return [{ code: 'UNKNOWN_DOMAIN', domain, message: 'unknown request domain' }]
  const requested = new Set(scopes)
  const issues: PromptScopeIssue[] = []
  for (const scope of requested) {
    if (!entry.allowed.includes(scope)) issues.push({ code: 'SCOPE_NOT_ALLOWED', domain, scope, message: scope + ' is not allowed for ' + domain })
  }
  for (const scope of entry.required) {
    if (!requested.has(scope)) issues.push({ code: 'REQUIRED_SCOPE_MISSING', domain, scope, message: scope + ' is required for ' + domain })
  }
  return issues
}

export function isPromptScopeSelectionValid(domain: PromptRequestDomain, scopes: readonly PromptScope[]): boolean {
  return getPromptScopeSelectionIssues(domain, scopes).length === 0
}

export type PromptMetadataIssue = {
  code: string
  path: string
  message: string
}

/** Validate the self-contained value used by history and artifact provenance. */
export function getPromptSnapshotIssues(value: unknown): PromptMetadataIssue[] {
  const issues: PromptMetadataIssue[] = []
  if (!isObject(value)) return [{ code: 'NOT_OBJECT', path: '', message: 'prompt snapshot must be an object' }]
  if (value.profileId !== undefined && !isNonEmptyString(value.profileId)) issues.push({ code: 'INVALID_PROFILE_ID', path: 'profileId', message: 'profileId must be a non-empty string when present' })
  const validKind = typeof value.kind === 'string' && PROMPT_KINDS.has(value.kind as PromptKind)
  if (!validKind) issues.push({ code: 'INVALID_KIND', path: 'kind', message: 'snapshot kind is invalid' })
  if (typeof value.name !== 'string') issues.push({ code: 'INVALID_NAME', path: 'name', message: 'snapshot name must be a string' })
  if (typeof value.content !== 'string') issues.push({ code: 'INVALID_CONTENT', path: 'content', message: 'snapshot content must be a string' })
  if (typeof value.source !== 'string' || !SNAPSHOT_SOURCES.has(value.source)) issues.push({ code: 'INVALID_SOURCE', path: 'source', message: 'snapshot source is invalid' })
  if (!isFiniteNumber(value.capturedAt) || value.capturedAt < 0) issues.push({ code: 'INVALID_CAPTURED_AT', path: 'capturedAt', message: 'capturedAt must be a non-negative finite number' })
  if (value.revision !== undefined && (!isFiniteNumber(value.revision) || !Number.isInteger(value.revision) || value.revision < 1)) issues.push({ code: 'INVALID_REVISION', path: 'revision', message: 'snapshot revision must be a positive integer when present' })
  if (!validKind) return issues

  const common = new Set(['profileId', 'kind', 'name', 'content', 'revision', 'source', 'capturedAt'])
  const allowed = new Set(common)
  switch (value.kind) {
    case 'conversation-mode':
      break
    case 'artifact':
      allowed.add('artifactKind')
      allowed.add('protocolId')
      if (typeof value.artifactKind !== 'string' || !ARTIFACT_KINDS.has(value.artifactKind)) add(issues, 'INVALID_ARTIFACT_KIND', 'artifactKind', 'artifactKind is not supported')
      if (value.protocolId !== undefined && !isNonEmptyString(value.protocolId)) add(issues, 'INVALID_PROTOCOL_ID', 'protocolId', 'protocolId must be a non-empty string when present')
      break
    case 'quick-follow-up':
      allowed.add('label')
      allowed.add('pinned')
      allowed.add('sortOrder')
      if (!isNonEmptyString(value.label)) add(issues, 'INVALID_LABEL', 'label', 'label must be a non-empty string')
      if (typeof value.pinned !== 'boolean') add(issues, 'INVALID_PINNED', 'pinned', 'pinned must be boolean')
      if (!isFiniteNumber(value.sortOrder) || !Number.isInteger(value.sortOrder) || value.sortOrder < 0) add(issues, 'INVALID_SORT_ORDER', 'sortOrder', 'sortOrder must be a non-negative integer')
      break
    case 'protocol':
      allowed.add('protocolDomain')
      allowed.add('outputContract')
      allowed.add('validator')
      allowed.add('overridePolicy')
      allowed.add('baseProtocolId')
      if (!isNonEmptyString(value.protocolDomain)) add(issues, 'INVALID_PROTOCOL_DOMAIN', 'protocolDomain', 'protocolDomain must be a non-empty string')
      if (value.outputContract !== undefined && typeof value.outputContract !== 'string') add(issues, 'INVALID_OUTPUT_CONTRACT', 'outputContract', 'outputContract must be a string when present')
      if (value.validator !== undefined && (!isObject(value.validator) || !isNonEmptyString(value.validator.name) || typeof value.validator.description !== 'string')) add(issues, 'INVALID_VALIDATOR', 'validator', 'validator metadata is invalid')
      if (typeof value.overridePolicy !== 'string' || !PROTOCOL_POLICIES.has(value.overridePolicy)) add(issues, 'INVALID_OVERRIDE_POLICY', 'overridePolicy', 'overridePolicy is not supported')
      if (value.baseProtocolId !== undefined && !isNonEmptyString(value.baseProtocolId)) add(issues, 'INVALID_BASE_PROTOCOL_ID', 'baseProtocolId', 'baseProtocolId must be a non-empty string when present')
      break
    default:
      return assertNever(value.kind as never)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) add(issues, 'UNEXPECTED_FIELD', key, 'field is not valid for snapshot kind ' + value.kind)
  }
  return issues
}

export function validatePromptSnapshot(value: unknown): PromptSnapshot | null {
  return getPromptSnapshotIssues(value).length === 0 ? value as PromptSnapshot : null
}

/**
 * Pure transition validator. `boundaryIds` is the effective message path for the
 * owning thread; passing it in keeps this domain helper independent of IDB/branch
 * storage while still rejecting transitions after an unrelated message.
 */
export function getPromptTransitionIssues(value: unknown, boundaryIds: readonly string[]): PromptMetadataIssue[] {
  const issues: PromptMetadataIssue[] = []
  if (!Array.isArray(value)) return [{ code: 'INVALID_TRANSITIONS', path: '', message: 'promptTransitions must be an array' }]
  const boundaries = new Set(boundaryIds)
  const order = new Map(boundaryIds.map((id, index) => [id, index]))
  const ids = new Set<string>()
  let previousPosition = -1
  let previousCreatedAt = -Infinity
  for (let i = 0; i < value.length; i++) {
    const transition = value[i]
    const path = 'promptTransitions[' + i + ']'
    if (!isObject(transition)) { issues.push({ code: 'INVALID_TRANSITION', path, message: 'transition must be an object' }); continue }
    if (!isNonEmptyString(transition.id)) issues.push({ code: 'INVALID_TRANSITION_ID', path: path + '.id', message: 'transition id is required' })
    else if (ids.has(transition.id)) issues.push({ code: 'DUPLICATE_TRANSITION_ID', path: path + '.id', message: 'transition id is duplicated' })
    else ids.add(transition.id)
    const boundaryId = transition.afterMessageId
    if (boundaryId !== null) {
      if (!isNonEmptyString(boundaryId)) issues.push({ code: 'INVALID_TRANSITION_BOUNDARY', path: path + '.afterMessageId', message: 'afterMessageId must be null or a message id' })
      else if (!boundaries.has(boundaryId)) issues.push({ code: 'UNKNOWN_TRANSITION_BOUNDARY', path: path + '.afterMessageId', message: 'transition boundary is not on the effective message path' })
    }
    const position = boundaryId === null ? -1 : (isNonEmptyString(boundaryId) ? (order.get(boundaryId) ?? -1) : -1)
    if (position < previousPosition) issues.push({ code: 'TRANSITION_ORDER', path, message: 'transition boundaries must be chronological' })
    previousPosition = Math.max(previousPosition, position)
    if (!isFiniteNumber(transition.createdAt) || transition.createdAt < 0) issues.push({ code: 'INVALID_TRANSITION_TIME', path: path + '.createdAt', message: 'createdAt must be non-negative and finite' })
    else if (transition.createdAt < previousCreatedAt) issues.push({ code: 'TRANSITION_TIME_ORDER', path, message: 'transition createdAt values must be chronological' })
    else previousCreatedAt = transition.createdAt
    if (getPromptSnapshotIssues(transition.snapshot).length > 0) issues.push(...getPromptSnapshotIssues(transition.snapshot).map((issue) => ({ ...issue, path: path + '.snapshot.' + issue.path })))
  }
  return issues
}

export function validatePromptTransitions(value: unknown, boundaryIds: readonly string[]): PromptTransition[] | null {
  return getPromptTransitionIssues(value, boundaryIds).length === 0 ? value as PromptTransition[] : null
}
