import { idbDelete, idbGet, idbGetAll, idbGetAllByIndex, idbPut, idbUpdateOrInsert } from '../storage/idb'
import { getBuiltinPrompt } from './prompt-registry'
import type { PromptDefinition, PromptKind } from './prompt-types'
import { assertPromptDefinition, validatePromptDefinition } from './prompt-validation'

export class PromptStoreError extends Error {
  readonly code: 'invalid' | 'builtin-id-collision' | 'corrupt-row' | 'id-exhausted'
  constructor(message: string, code: PromptStoreError['code'] = 'invalid') { super(message); this.name = 'PromptStoreError'; this.code = code }
}

function assertPersistable(value: unknown): PromptDefinition {
  const definition = validatePromptDefinition(value)
  if (!definition) throw new PromptStoreError('提示词定义格式非法', 'invalid')
  if (getBuiltinPrompt(definition.id)) throw new PromptStoreError('提示词定义不能占用 built-in ID：' + definition.id, 'builtin-id-collision')
  if (definition.source === 'builtin') throw new PromptStoreError('内置提示词不写入 prompts store', 'invalid')
  return definition
}

/** Raw durable operations for custom definitions and experimental protocol overrides. */
export async function getPromptRecord(id: string): Promise<PromptDefinition | undefined> {
  const row = await idbGet('prompts', id)
  if (row === undefined) return undefined
  return assertPersistable(row)
}

export async function listPromptRecords(): Promise<PromptDefinition[]> {
  const rows = await idbGetAll('prompts')
  return rows.map((row: unknown) => assertPersistable(row))
}

export async function listPromptRecordsByKind(kind: PromptKind): Promise<PromptDefinition[]> {
  const rows = await idbGetAllByIndex('prompts', 'by_kind', kind)
  return rows.map((row: unknown) => assertPersistable(row))
}

/** Resolve only after the prompts transaction commits (idbPut waits for oncomplete). */
export async function savePromptRecord(value: PromptDefinition): Promise<void> {
  await idbPut('prompts', assertPersistable(value))
}

/**
 * Service-level semantic update. The durable current row is read inside the
 * same transaction that writes the next row, so two tabs cannot both publish
 * the same revision N+1.
 */
export async function updatePromptRecordAtomic(
  id: string,
  updater: (current: PromptDefinition | undefined) => PromptDefinition,
): Promise<PromptDefinition> {
  const value = await idbUpdateOrInsert<PromptDefinition | undefined>('prompts', id, undefined, (raw) => {
    const current = raw === undefined ? undefined : assertPersistable(raw)
    const next = assertPersistable(updater(current))
    if (next.id !== id) throw new PromptStoreError('提示词更新不能改变 ID', 'invalid')
    if (current && (next.kind !== current.kind || next.source !== current.source)) throw new PromptStoreError('提示词更新不能改变 kind 或 source', 'invalid')
    return next
  })
  if (!value) throw new PromptStoreError('提示词更新未提交', 'invalid')
  return assertPersistable(value)
}

/** Generate an ID that cannot collide with source-owned or durable prompts. */
export async function allocateAvailablePromptId(generate: () => string, attempts = 100): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = generate()
    if (typeof candidate !== 'string' || candidate.length === 0 || getBuiltinPrompt(candidate)) continue
    if (await idbGet('prompts', candidate) === undefined) return candidate
  }
  throw new PromptStoreError('无法生成不冲突的提示词 ID', 'id-exhausted')
}

export async function deletePromptRecord(id: string): Promise<void> {
  await idbDelete('prompts', id)
}

export const getPrompt = getPromptRecord
export const listPrompts = listPromptRecords
export const savePrompt = savePromptRecord
export const deletePrompt = deletePromptRecord

// Keep the assertion available to service tests without exposing IndexedDB details.
export { assertPromptDefinition }
