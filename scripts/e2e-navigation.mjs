export async function dismissProductGuide(page) {
  const guide = page.locator('[data-testid="product-guide"]')
  await guide.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
  if (await guide.isVisible().catch(() => false)) {
    await page.locator('[data-testid="product-guide-later"]').click()
    await guide.waitFor({ state: 'hidden', timeout: 10000 })
  }
}

export async function openDocumentLibrary(page) {
  await dismissProductGuide(page)
  const library = page.locator('[data-testid="document-library"]')
  if (await library.isVisible().catch(() => false)) return

  const sidebarEntry = page.locator('[data-testid="sidebar-entry-files"]')
  if (await sidebarEntry.isVisible().catch(() => false)) {
    await sidebarEntry.click()
  } else {
    const railEntry = page.locator('[data-testid="rail-files"]')
    if (await railEntry.isVisible().catch(() => false)) {
      await railEntry.click()
    } else {
      const railHistory = page.locator('[data-testid="rail-history"]')
      if (!(await railHistory.isVisible().catch(() => false))) {
        throw new Error('Document Library navigation unavailable: no visible files or history rail')
      }
      await railHistory.click()
      const drawer = page.locator('[data-testid="mobile-history-drawer"]')
      await drawer.waitFor({ state: 'visible', timeout: 10000 })
      const drawerEntry = drawer.locator('[data-testid="sidebar-entry-files"]')
      await drawerEntry.waitFor({ state: 'visible', timeout: 10000 })
      await drawerEntry.click()
    }
  }

  await library.waitFor({ state: 'visible', timeout: 10000 })
}
