/**
 * Enter Chapter Builder through the Reader's canonical directory action.
 * The top-bar reader-build shortcut is intentionally not part of the contract.
 */
export async function openChapterBuilderForSource(page, chapterSource, { addCurrentPage = false } = {}) {
  const testId = chapterSource === 'none'
    ? 'reader-toc-create'
    : chapterSource === 'native'
      ? 'reader-toc-organize'
      : chapterSource === 'manual' || chapterSource === 'ai-toc'
        ? 'reader-toc-edit'
        : null
  if (!testId) throw new Error('unsupported chapterSource: ' + chapterSource)
  const tocInViewport = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="reader-toc"]')
    if (!node) return false
    const rect = node.getBoundingClientRect()
    return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
  })
  if (!tocInViewport) {
    await page.locator('[data-testid="reader-toc-toggle"]').click()
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="reader-toc"]')
      if (!node) return false
      const rect = node.getBoundingClientRect()
      return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
    }, null, { timeout: 10000 })
  }
  await page.locator('[data-testid="' + testId + '"]').click()
  await page.locator('[data-testid="chapter-builder"]').waitFor({ state: 'visible', timeout: 10000 })
  if (addCurrentPage) await page.locator('[data-testid="cb-add"]').click()
}
