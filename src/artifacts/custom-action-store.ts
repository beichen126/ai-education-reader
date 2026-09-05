// Saved reusable "自定义操作" persistence (v1.1.3). Stored as ONE row in the existing
// settings IndexedDB KV store (store:settings, key='customArtifactActions'), so it reuses the
// durable local persistence AND is automatically carried by the settings portion of a full
// backup/import. No new store / DB version bump, no schema churn. The UI never touches raw
// IndexedDB — it only uses list/create/update/delete below.
import { getSetting, setSetting } from '../storage/storage'
import { newStableId } from '../engine/types'
import type { CustomArtifactAction } from './artifact-types'

const KEY = 'customArtifactActions'

function normalize(raw: unknown): CustomArtifactAction[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is CustomArtifactAction => !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.prompt === 'string')
}

/** All saved custom actions, newest-first. Empty if none (or a legacy backup lacks them). */
export async function listCustomActions(): Promise<CustomArtifactAction[]> {
  const rows = normalize(await getSetting(KEY))
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function createCustomAction(input: { name: string; prompt: string }): Promise<CustomArtifactAction> {
  const name = String(input.name ?? '').trim()
  const prompt = String(input.prompt ?? '').trim()
  if (name === '' || prompt === '') throw new Error('操作名称与提示词都不能为空')
  const list = await listCustomActions()
  const now = Date.now()
  const action: CustomArtifactAction = { id: newStableId(), name, prompt, createdAt: now, updatedAt: now }
  await setSetting(KEY, [action, ...list])
  return action
}

export async function updateCustomAction(id: string, patch: { name?: string; prompt?: string }): Promise<CustomArtifactAction | null> {
  const list = await listCustomActions()
  const idx = list.findIndex((a) => a.id === id)
  if (idx < 0) return null
  const cur = list[idx]
  const next: CustomArtifactAction = {
    ...cur,
    name: (patch.name ?? cur.name).trim(),
    prompt: (patch.prompt ?? cur.prompt).trim(),
    updatedAt: Date.now(),
  }
  const copy = list.slice()
  copy[idx] = next
  await setSetting(KEY, copy)
  return next
}

export async function deleteCustomAction(id: string): Promise<void> {
  const list = await listCustomActions()
  await setSetting(KEY, list.filter((a) => a.id !== id))
}

/** Stored row value, used by backup export/import (they reuse the settings transport). */
export async function readCustomActionsRaw(): Promise<CustomArtifactAction[]> {
  return normalize(await getSetting(KEY))
}
