import { useSyncExternalStore } from 'react'
import type { StableId } from './types'
import { getSetting, setSetting, deleteSetting } from '../storage/storage'
import { existsAttachment } from './attachment-service'

/**
 * Per-conversation composer draft. The in-memory map is the synchronous source of
 * truth for React; persistence to IndexedDB (settings store, namespaced key
 * draft:<conversationId>) is a best-effort async layer so drafts survive reloads.
 * Non-empty drafts are persisted; empty drafts are not kept as rows.
 */
export type Draft = { text: string; imageIds: StableId[] }
const KEY = 'draft:'
const BRANCH_PREFIX = 'B:'
/** The persisted settings key for a conversation's draft (used by atomic send accept). */
export function draftSettingKey(conversationId: string): string { return KEY + conversationId }
/** In-memory draft-map key for a branch thread (keeps root + branch drafts isolated). */
export function branchThreadKey(branchId: StableId): string { return BRANCH_PREFIX + branchId }
/** The persisted settings key for a branch's draft (isolated namespace, never collides with root). */
export function branchDraftSettingKey(branchId: StableId): string { return 'draft-branch:' + branchId }
/** Map a draft thread key to its persisted settings key. Root keeps the v1 'draft:<id>' shape. */
function storageKeyFor(threadId: string): string {
  if (threadId.startsWith(BRANCH_PREFIX)) return 'draft-branch:' + threadId.slice(BRANCH_PREFIX.length)
  return KEY + threadId
}
const VERSION = 1
const TEXT_DEBOUNCE_MS = 500

const drafts = new Map<string, Draft>()
const subs = new Set<() => void>()
const textTimers = new Map<string, ReturnType<typeof setTimeout>>()

function emit() { subs.forEach(f => f()) }
function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }

/** Stable reference: materializes an empty draft on first read so useSyncExternalStore sees a constant snapshot. */
export function getDraft(id: string): Draft {
  let d = drafts.get(id)
  if (!d) { d = { text: '', imageIds: [] }; drafts.set(id, d) }
  return d
}
function put(id: string, d: Draft) { drafts.set(id, d); emit() }
function cancelTextTimer(id: string) { const t = textTimers.get(id); if (t !== undefined) { clearTimeout(t); textTimers.delete(id) } }

async function persistDraft(id: string): Promise<void> {
  const d = drafts.get(id)
  // An empty draft leaves no storage row -> no stale empty entries.
  if (!d || (d.text === '' && d.imageIds.length === 0)) {
    try { await deleteSetting(storageKeyFor(id)) } catch { /* already gone */ }
    return
  }
  try { await setSetting(storageKeyFor(id), { version: VERSION, text: d.text, imageIds: d.imageIds }) }
  catch (e) { console.error('[draft] persist failed', id, e) }
}

/** Text is debounced so a keystroke storm doesn't spam IndexedDB transactions. */
export function setDraftText(id: string, text: string): void {
  put(id, { text, imageIds: getDraft(id).imageIds })
  cancelTextTimer(id)
  textTimers.set(id, setTimeout(() => { textTimers.delete(id); void persistDraft(id) }, TEXT_DEBOUNCE_MS))
}

export function addDraftImages(id: string, ids: StableId[]): void {
  const cur = getDraft(id)
  put(id, { text: cur.text, imageIds: [...new Set([...cur.imageIds, ...ids])] })
  void persistDraft(id)
}
/** Update the in-memory draft object without any database write. Used when the durable
 *  draft row was already committed atomically (e.g. PDF Context commit) — must NOT issue a
 *  second DB mutation. */
export function updateDraftMemory(id: string, d: Draft): void {
  put(id, d)
}
export function removeDraftImage(id: string, img: StableId): void {
  const cur = getDraft(id)
  put(id, { text: cur.text, imageIds: cur.imageIds.filter(x => x !== img) })
  void persistDraft(id)
}

/** Clear text + image ids WITHOUT deleting attachments (ownership moves to a Message on send).
 * Memory is updated synchronously; the persisted row is removed and awaited. */
export async function clearDraft(id: string): Promise<void> {
  cancelTextTimer(id)
  put(id, { text: '', imageIds: [] })
  try { await deleteSetting(storageKeyFor(id)) } catch (e) { console.error('[draft] clear delete failed', id, e) }
}
export async function deleteDraft(id: string): Promise<void> {
  cancelTextTimer(id)
  if (drafts.delete(id)) emit()
  try { await deleteSetting(storageKeyFor(id)) } catch (e) { console.error('[draft] delete failed', id, e) }
}
/** Clear ONLY the in-memory draft state (no database mutation). Used after the durable
 *  send-accept transaction already deleted the draft row atomically — clearing memory
 *  here must not issue an extra (duplicate) write. */
export function clearDraftMemory(id: string): void {
  cancelTextTimer(id)
  put(id, { text: '', imageIds: [] })
}

/** Test/utility hook: flush a conversation's pending debounced text persist now. */
export async function flushDraft(id: string): Promise<void> { cancelTextTimer(id); await persistDraft(id) }
/** Best-effort flush of every pending text draft (used on pagehide / visibilitychange). */
export async function flushAllDrafts(): Promise<void> {
  const ids = [...textTimers.keys()]
  for (const id of ids) { cancelTextTimer(id); await persistDraft(id) }
}

function parseDraft(raw: any): Draft | null {
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return null
  if (!Array.isArray(raw.imageIds)) return null
  const imageIds = raw.imageIds.filter((x: any): x is string => typeof x === 'string')
  return { text: raw.text, imageIds }
}

/** Drop the in-memory draft cache (e.g. after a backup restore replaced all data). */
export function resetDrafts(): void {
  for (const id of textTimers.keys()) { const t = textTimers.get(id); if (t !== undefined) clearTimeout(t) }
  textTimers.clear(); drafts.clear(); emit()
}

/**
 * Restore persisted drafts for a list of conversations at boot. Prunes image ids whose
 * attachment no longer exists (so the UI never shows a ghost). Corrupt entries are
 * dropped and their persisted record deleted. Never throws — a bad draft must not
 * take down the whole app.
 */
/** Restore one persisted draft row into memory, pruning attachments that no longer exist. */
async function restoreDraft(threadId: string, storageKey: string): Promise<void> {
  let raw: any
  try { raw = await getSetting(storageKey) } catch (e) { console.error('[draft] read failed', threadId, e); return }
  if (raw === undefined) return
  const d = parseDraft(raw)
  if (!d) { try { await deleteSetting(storageKey) } catch { /* ignore */ } return }
  const pruned: StableId[] = []
  let changed = false
  for (const img of d.imageIds) {
    let ok = false
    try { ok = await existsAttachment(img) } catch { ok = false }
    if (ok) pruned.push(img); else changed = true
  }
  drafts.set(threadId, { text: d.text, imageIds: pruned })
  if (changed) try { await setSetting(storageKey, { version: VERSION, text: d.text, imageIds: pruned }) } catch { /* ignore */ }
}

export async function initDrafts(conversationIds: string[]): Promise<void> {
  try {
    for (const id of conversationIds) await restoreDraft(id, draftSettingKey(id))
  } catch (e) {
    console.error('[draft] initDrafts failed', e)
  }
  emit()
}

/** Restore every BRANCH draft (keyed draft-branch:<branchId>) at boot. */
export async function initBranchDrafts(branchIds: StableId[]): Promise<void> {
  try {
    for (const id of branchIds) await restoreDraft(branchThreadKey(id), branchDraftSettingKey(id))
  } catch (e) {
    console.error('[draft] initBranchDrafts failed', e)
  }
  emit()
}

// ---- Branch draft accessors (isolated namespace, distinct map keys from root drafts) ----
export function getBranchDraft(branchId: StableId): Draft { return getDraft(branchThreadKey(branchId)) }
export function setBranchDraftText(branchId: StableId, text: string): void { setDraftText(branchThreadKey(branchId), text) }
export function addBranchDraftImages(branchId: StableId, ids: StableId[]): void { addDraftImages(branchThreadKey(branchId), ids) }
export function removeBranchDraftImage(branchId: StableId, img: StableId): void { removeDraftImage(branchThreadKey(branchId), img) }
export function clearBranchDraftMemory(branchId: StableId): void { clearDraftMemory(branchThreadKey(branchId)) }
export async function deleteBranchDraft(branchId: StableId): Promise<void> { await deleteDraft(branchThreadKey(branchId)) }
export async function flushBranchDraft(branchId: StableId): Promise<void> { await flushDraft(branchThreadKey(branchId)) }

export function useDraft(id: string): Draft { return useSyncExternalStore(subscribe, () => getDraft(id)) }

