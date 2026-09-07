import { idbDelete, idbGet, idbGetAll, idbGetAllByIndex, idbPut } from '../storage/idb'
import type { PromptDefinition, PromptKind } from './prompt-types'
import { assertPromptDefinition, validatePromptDefinition } from './prompt-validation'

export class PromptStoreError extends Error {
  constructor(message: string) { super(message); this.name = 'PromptStoreError' }
}

function assertPersistable(value: unknown): PromptDefinition {
  const definition = validatePromptDefinition(value)
  if (!definition) throw new PromptStoreError('提示词定义格式非法')
  if (definition.source === 'builtin') throw new PromptStoreError('内置提示词不写入 prompts store')
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

export async function deletePromptRecord(id: string): Promise<void> {
  await idbDelete('prompts', id)
}

export const getPrompt = getPromptRecord
export const listPrompts = listPromptRecords
export const savePrompt = savePromptRecord
export const deletePrompt = deletePromptRecord

// Keep the assertion available to service tests without exposing IndexedDB details.
export { assertPromptDefinition }
