import { getSetting, setSetting } from '../storage/storage'

export const PRODUCT_GUIDE_VERSION = '2.1.0'
const PRODUCT_GUIDE_SEEN_KEY = 'productGuideSeenVersion'

/** Read the guide marker without adding a new IndexedDB store or schema version. */
export async function getProductGuideSeenVersion(): Promise<string | undefined> {
  const value = await getSetting(PRODUCT_GUIDE_SEEN_KEY)
  return typeof value === 'string' ? value : undefined
}

/**
 * Mark the current guide version as seen. This is intentionally best-effort at the
 * caller: a settings write failure must never prevent the app from becoming usable.
 * The test seam lets browser tests prove that failure path without changing storage.
 */
export async function markProductGuideSeen(): Promise<void> {
  if ((globalThis as { __dshProductGuideMarkerFailure?: boolean }).__dshProductGuideMarkerFailure) {
    throw new Error('injected product guide marker failure')
  }
  await setSetting(PRODUCT_GUIDE_SEEN_KEY, PRODUCT_GUIDE_VERSION)
}
