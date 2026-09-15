
import { createStore, useStore } from './store'
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX, DETAILS_DEFAULT, DETAILS_MIN, DETAILS_MAX, clampWidth } from '../dsh/layout/columns'
import { getSetting, setSetting } from '../storage/storage'

export const LAYOUT_PREFERENCES_KEY = 'layoutPreferences'
export type LayoutPreferences = { version: 1; sidebar: number; lastExpandedSidebar: number }
export type LayoutState = { sidebar: number; lastExpandedSidebar: number; details: number; narrow: boolean; narrowExpanded: boolean }

export function normalizeExpandedSidebarWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clampWidth(value, SIDEBAR_MIN, SIDEBAR_MAX)
    : SIDEBAR_DEFAULT
}

export function normalizeLayoutPreferences(value: unknown): LayoutPreferences {
  const raw = value && typeof value === 'object' ? value as Partial<LayoutPreferences> : {}
  const lastExpandedSidebar = normalizeExpandedSidebarWidth(raw.lastExpandedSidebar)
  return {
    version: 1,
    sidebar: raw.sidebar === 0 ? 0 : normalizeExpandedSidebarWidth(raw.sidebar),
    lastExpandedSidebar,
  }
}

export const layoutStore = createStore<LayoutState>(() => ({ sidebar: SIDEBAR_DEFAULT, lastExpandedSidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false }), {
  setSidebar: (d, px) => {
    if (px === 0) return { ...d, sidebar: 0 }
    const sidebar = normalizeExpandedSidebarWidth(px)
    return { ...d, sidebar, lastExpandedSidebar: sidebar }
  },
  // Pointer-move previews must not replace the last committed expanded width:
  // a gesture may still finish by snapping back to the collapsed rail.
  previewSidebar: (d, px) => ({ ...d, sidebar: px === 0 ? 0 : normalizeExpandedSidebarWidth(px) }),
  hydrateSidebar: (d, preferences) => ({ ...d, ...normalizeLayoutPreferences(preferences) }),
  setDetails: (d, px) => ({ ...d, details: clampWidth(px, DETAILS_MIN, DETAILS_MAX) }),
  toggleSidebar: (d) => ({ ...d, sidebar: d.sidebar === 0 ? d.lastExpandedSidebar : 0 }),
  // Narrow rail <-> expanded full sidebar. On a narrow viewport the rendered
  // sidebar follows narrowExpanded (AppFrame decides), so these three are the
  // only actions that (re)open or collapse it there.
  openNarrowSidebar: (d) => ({ ...d, narrowExpanded: true }),
  closeNarrowSidebar: (d) => ({ ...d, narrowExpanded: false }),
  toggleNarrowSidebar: (d) => ({ ...d, narrowExpanded: !d.narrowExpanded }),
  setNarrow: (d, narrow) => ({ ...d, narrow, narrowExpanded: narrow ? d.narrowExpanded : false }),
  openDetails: (d) => ({ ...d, details: d.details === 0 ? DETAILS_DEFAULT : d.details }),
  closeDetails: (d) => ({ ...d, details: 0 }),
})
export function useLayoutStore<T>(sel: (s: LayoutState) => T): T { return useStore(layoutStore, sel) }

let persistQueue: Promise<unknown> = Promise.resolve()

/** Load the last desktop sidebar state. Missing/corrupt legacy values safely use defaults. */
export async function initLayout(): Promise<void> {
  let stored: unknown
  try { stored = await getSetting(LAYOUT_PREFERENCES_KEY) } catch { stored = undefined }
  layoutStore.actions.hydrateSidebar(normalizeLayoutPreferences(stored))
}

/** Persist only after a completed gesture/action. Writes are serialized so a rapid
 * collapse/reopen sequence cannot finish out of order and resurrect stale geometry. */
export function persistSidebarLayout(): Promise<void> {
  const snapshot = layoutStore.getSnapshot()
  const preferences = normalizeLayoutPreferences({
    version: 1,
    sidebar: snapshot.sidebar,
    lastExpandedSidebar: snapshot.lastExpandedSidebar,
  })
  const commit = () => setSetting(LAYOUT_PREFERENCES_KEY, preferences)
  const run = persistQueue.then(commit, commit)
  persistQueue = run.then(() => undefined, () => undefined)
  return run
}
