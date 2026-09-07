import type { QuickFollowUpPrompt } from './prompt-types'

/** Enabled Quick Follow-ups have a stable, user-controlled order independent of catalog sort. */
export function sortEnabledQuickFollowUps(items: readonly QuickFollowUpPrompt[]): QuickFollowUpPrompt[] {
  return items
    .filter((item) => item.enabled)
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || a.sortOrder - b.sortOrder
      || a.updatedAt - b.updatedAt
      || a.label.localeCompare(b.label, 'zh-CN')
      || a.id.localeCompare(b.id))
}
