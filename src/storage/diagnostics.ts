import { idbScan } from './idb'

export type StorageDiagnostics = {
  /** Origin's total estimated storage usage (navigator.storage.estimate). undefined when API unavailable. */
  originUsageBytes?: number
  /** Browser quota estimate for this Origin (navigator.storage.estimate). undefined when API unavailable. */
  originQuotaBytes?: number
  attachmentCount: number
  attachmentBytes: number
}

function trimZeros(s: string): string {
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

/** Human-readable byte size: B / KB / MB / GB (1-2 decimals; never a raw byte count). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return Math.round(bytes) + ' B'
  const kb = bytes / 1024
  if (kb < 1024) return trimZeros(kb.toFixed(1)) + ' KB'
  const mb = kb / 1024
  if (mb < 1024) return trimZeros(mb.toFixed(1)) + ' MB'
  return trimZeros((mb / 1024).toFixed(2)) + ' GB'
}

/**
 * READ-ONLY storage diagnostics.
 * - originUsageBytes / originQuotaBytes come from navigator.storage.estimate()
 *   (feature-detected; left undefined when it is unavailable).
 * - attachmentCount / attachmentBytes are computed by scanning the 'attachments'
 *   store with a cursor and reading ONLY row.blob.size — never arrayBuffer(),
 *   base64, FileReader or Object URLs — so a large collection is counted without a
 *   big JS memory spike.
 * This function performs NO mutation, cleanup, GC or deletion.
 */
export async function getStorageDiagnostics(): Promise<StorageDiagnostics> {
  let usage: number | undefined
  let quota: number | undefined
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined
    const estimate = nav?.storage?.estimate
    if (typeof estimate === 'function') {
      const r = await estimate.call(nav.storage)
      if (r && typeof r.usage === 'number') usage = r.usage
      if (r && typeof r.quota === 'number') quota = r.quota
    }
  } catch { /* feature unavailable -> leave usage/quota undefined */ }
  let attachmentCount = 0
  let attachmentBytes = 0
  try {
    await idbScan('attachments', (row) => {
      attachmentCount++
      const b = row?.blob
      attachmentBytes += b && typeof b.size === 'number' ? b.size : 0
    })
  } catch { /* scan failure -> still return origin stats + zeros */ }
  return {
    ...(usage !== undefined ? { originUsageBytes: usage } : {}),
    ...(quota !== undefined ? { originQuotaBytes: quota } : {}),
    attachmentCount,
    attachmentBytes,
  }
}

