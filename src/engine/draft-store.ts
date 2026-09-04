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
/** The persisted settings key for a conversation's draft (used by atomic send accept). */
export function draftSettingKey(conversationId: string): string { return KEY + conversationId }
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
    try { await deleteSetting(KEY + id) } catch { /* already gone */ }
    return
  }
  try { await setSetting(KEY + id, { version: VERSION, text: d.text, imageIds: d.imageIds }) }
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
  try { await deleteSetting(KEY + id) } catch (e) { console.error('[draft] clear delete failed', id, e) }
}
export async function deleteDraft(id: string): Promise<void> {
  cancelTextTimer(id)
  if (drafts.delete(id)) emit()
  try { await deleteSetting(KEY + id) } catch (e) { console.error('[draft] delete failed', id, e) }
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
export async function initDrafts(conversationIds: string[]): Promise<void> {
  try {
    for (const id of conversationIds) {
      let raw: any
      try { raw = await getSetting(KEY + id) } catch (e) { console.error('[draft] read failed', id, e); continue }
      if (raw === undefined) continue
      const d = parseDraft(raw)
      if (!d) { try { await deleteSetting(KEY + id) } catch { /* ignore */ } continue }
      const pruned: StableId[] = []
      let changed = false
      for (const img of d.imageIds) {
        let ok = false
        try { ok = await existsAttachment(img) } catch { ok = false }
        if (ok) pruned.push(img); else changed = true
      }
      drafts.set(id, { text: d.text, imageIds: pruned })
      if (changed) try { await setSetting(KEY + id, { version: VERSION, text: d.text, imageIds: pruned }) } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('[draft] initDrafts failed', e)
  }
  emit()
}

export function useDraft(id: string): Draft { return useSyncExternalStore(subscribe, () => getDraft(id)) }

