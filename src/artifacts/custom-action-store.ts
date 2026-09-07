// Saved reusable "自定义操作" persistence (v1.1.3). Pre-migration data remains readable from
// the legacy settings KV row (key='customArtifactActions'); after prompt migration, the
// canonical rows live in the prompts store and the legacy row is read-only compatibility data.
// The UI never touches raw IndexedDB — it only uses list/create/update/delete below.
import { getSetting, setSetting } from '../storage/storage'
import { newStableId } from '../engine/types'
import { getPromptRecord, listPromptRecordsByKind, savePromptRecord, deletePromptRecord } from '../prompts/prompt-store'
import { hasLegacyPromptMigrationMarker } from '../prompts/prompt-migration'
import type { ArtifactPrompt } from '../prompts/prompt-types'
import type { CustomArtifactAction } from './artifact-types'

const KEY = 'customArtifactActions'

function normalize(raw: unknown): CustomArtifactAction[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is CustomArtifactAction => !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.prompt === 'string')
}

function actionOf(prompt: ArtifactPrompt): CustomArtifactAction {
  return { id: prompt.id, name: prompt.name, prompt: prompt.userPrompt, createdAt: prompt.createdAt, updatedAt: prompt.updatedAt }
}

async function usePromptStore(): Promise<boolean> {
  if (await hasLegacyPromptMigrationMarker()) return true
  // A restored V6 backup may contain the migrated prompt rows but not the internal
  // marker. Prefer the canonical store in that case, while keeping direct v1 tests
  // and genuinely pre-migration data readable from the legacy settings row.
  const prompts = await listPromptRecordsByKind('artifact')
  return prompts.some((prompt) => prompt.kind === 'artifact' && prompt.artifactKind === 'custom' && prompt.source !== 'builtin')
}

async function listPromptActions(): Promise<CustomArtifactAction[]> {
  const prompts = await listPromptRecordsByKind('artifact')
  return prompts
    .filter((prompt): prompt is ArtifactPrompt => prompt.kind === 'artifact' && prompt.artifactKind === 'custom' && prompt.source !== 'builtin')
    .map(actionOf)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** All saved custom actions, newest-first. Empty if none (or a legacy backup lacks them). */
export async function listCustomActions(): Promise<CustomArtifactAction[]> {
  if (await usePromptStore()) return listPromptActions()
  const rows = normalize(await getSetting(KEY))
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function createCustomAction(input: { name: string; prompt: string }): Promise<CustomArtifactAction> {
  const name = String(input.name ?? '').trim()
  const prompt = String(input.prompt ?? '').trim()
  if (name === '' || prompt === '') throw new Error('操作名称与提示词都不能为空')
  const now = Date.now()
  if (await usePromptStore()) {
    const definition: ArtifactPrompt = {
      id: newStableId(), kind: 'artifact', artifactKind: 'custom', name, description: '用户自定义学习成果操作。',
      source: 'custom', enabled: true, createdAt: now, updatedAt: now, revision: 1, userPrompt: prompt,
    }
    await savePromptRecord(definition)
    return actionOf(definition)
  }
  const list = await listCustomActions()
  const action: CustomArtifactAction = { id: newStableId(), name, prompt, createdAt: now, updatedAt: now }
  await setSetting(KEY, [action, ...list])
  return action
}

export async function updateCustomAction(id: string, patch: { name?: string; prompt?: string }): Promise<CustomArtifactAction | null> {
  if (await usePromptStore()) {
    const current = await getPromptRecord(id)
    if (!current || current.kind !== 'artifact' || current.artifactKind !== 'custom' || current.source === 'builtin') return null
    const name = (patch.name ?? current.name).trim()
    const prompt = (patch.prompt ?? current.userPrompt).trim()
    if (name === '' || prompt === '') throw new Error('操作名称与提示词都不能为空')
    const next: ArtifactPrompt = { ...current, name, userPrompt: prompt, updatedAt: Date.now(), revision: prompt === current.userPrompt ? current.revision : current.revision + 1 }
    await savePromptRecord(next)
    return actionOf(next)
  }
  const list = await listCustomActions()
  const idx = list.findIndex((a) => a.id === id)
  // Domain invariant: a missing id is an explicit, handleable result (never silently no-op).
  if (idx < 0) return null
  const cur = list[idx]
  const name = (patch.name ?? cur.name).trim()
  const prompt = (patch.prompt ?? cur.prompt).trim()
  // Domain invariant: name / prompt must be non-empty after trim (the UI is NOT the only guard).
  if (name === '' || prompt === '') throw new Error('操作名称与提示词都不能为空')
  const next: CustomArtifactAction = { ...cur, name, prompt, updatedAt: Date.now() }
  const copy = list.slice()
  copy[idx] = next
  await setSetting(KEY, copy)
  return next
}

export async function deleteCustomAction(id: string): Promise<void> {
  if (await usePromptStore()) {
    const current = await getPromptRecord(id)
    if (current && current.kind === 'artifact' && current.artifactKind === 'custom' && current.source !== 'builtin') await deletePromptRecord(id)
    return
  }
  const list = await listCustomActions()
  await setSetting(KEY, list.filter((a) => a.id !== id))
}

/** Stored row value, used by backup export/import (they reuse the settings transport). */
export async function readCustomActionsRaw(): Promise<CustomArtifactAction[]> {
  return listCustomActions()
}
