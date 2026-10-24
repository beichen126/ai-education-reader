export async function dismissProductGuide(page) {
  const guide = page.locator('[data-testid="product-guide"]')
  await guide.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
  if (await guide.isVisible().catch(() => false)) {
    await page.locator('[data-testid="product-guide-later"]').click()
    await guide.waitFor({ state: 'hidden', timeout: 10000 })
  }
}

export async function openProductGuide(page) {
  await openSettings(page, 'help')
  await page.getByTestId('settings-user-guide').click()
  await page.getByTestId('product-guide').waitFor({ state: 'visible' })
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
      const phoneMenu = page.locator('[data-testid="mobile-menu-toggle"]')
      const railHistory = await phoneMenu.isVisible().catch(() => false) ? phoneMenu : page.locator('[data-testid="rail-history"]')
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

/** Settings owns the only first-level prompt-management entry (v2.2.0 §6). */
export const PROMPT_ENTRY_CONTROL = {
  all: 'settings-prompts-all',
  'conversation-mode': 'settings-prompts-conversation-mode',
  artifact: 'settings-prompts-artifact',
  'quick-follow-up': 'settings-prompts-quick-follow-up',
}

export async function selectSettingsSection(page, section) {
  const tab = page.locator('[data-testid="settings-nav-' + section + '"]')
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click()
}

export async function openSettings(page, section = 'general') {
  await dismissProductGuide(page)
  const dialog = page.locator('[role="dialog"][aria-label="设置"], [role="dialog"][aria-label="Settings"]')
  if (await dialog.isVisible().catch(() => false)) { await selectSettingsSection(page, section); return dialog }
  const sidebarEntry = page.locator('[data-testid="sidebar-settings"]')
  if (await sidebarEntry.isVisible().catch(() => false)) await sidebarEntry.click()
  else if (await page.locator('[data-testid="mobile-menu-toggle"]').isVisible().catch(() => false)) {
    await page.locator('[data-testid="mobile-menu-toggle"]').click()
    await page.locator('[data-testid="mobile-history-drawer"] [data-testid="sidebar-settings"]').click()
  } else await page.locator('[data-testid="rail-settings"]').click()
  await selectSettingsSection(page, section)
  await page.locator('[role="tabpanel"]:visible').waitFor({ state: 'visible', timeout: 10000 })
  return dialog
}

/**
 * Open Prompt Manager the way a user must in v2.2.0: Settings -> 提示词管理 -> category.
 * Returns the manager dialog.
 */
export async function openPromptManager(page, category = 'all') {
  const manager = page.locator('[data-testid="prompt-manager"]')
  if (await manager.isVisible().catch(() => false)) return manager
  await openSettings(page)
  const control = PROMPT_ENTRY_CONTROL[category] ?? PROMPT_ENTRY_CONTROL.all
  await page.locator('[data-testid="' + control + '"]').click()
  await manager.waitFor({ state: 'visible', timeout: 10000 })
  return manager
}

/** Close Prompt Manager and the Settings dialog it returns to, leaving the app usable. */
export async function closePromptManager(page) {
  const manager = page.locator('[data-testid="prompt-manager"]')
  if (await manager.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await manager.waitFor({ state: 'hidden', timeout: 10000 })
  }
  const settings = page.locator('[role="dialog"][aria-label="设置"]')
  if (await settings.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden', timeout: 10000 })
  }
}
