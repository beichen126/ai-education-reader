import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot, msg } from './e2e-fixture.mjs'

const browser = await launchBrowser()
try {
  for (const width of [1280, 390]) {
    const narrow = width < 600
    const page = await browser.newPage({ viewport: { width: 1280, height: 844 }, hasTouch: narrow })
    await seedAndBoot(page, {
      convs: [
        { id: 'newer', title: 'Newer chat', createdAt: 2, updatedAt: 2, messages: [] },
        { id: 'older', title: 'Older chat', createdAt: 1, updatedAt: 1, messages: [msg('a', 'assistant', 'Keep this answer')] },
      ],
      settings: { lastConversationId: 'newer' },
    })
    await page.setViewportSize({ width, height: 844 })
    const openSidebar = async () => {
      if (narrow) await page.getByTestId('mobile-menu-toggle').click()
    }
    const history = page.getByTestId('history-session')
    const older = history.filter({ hasText: 'Older chat' })
    const archive = page.getByRole('button', { name: '归档', exact: true })
    const choose = async action => {
      await older.locator('..').getByRole('button', { name: '操作', exact: true }).click()
      await older.locator('..').getByRole('button', { name: action, exact: true }).click()
    }

    await openSidebar()
    await choose('置顶')
    await history.first().getByText('Older chat', { exact: true }).waitFor()
    await page.reload()
    await openSidebar()
    await history.first().getByText('Older chat', { exact: true }).waitFor()
    await choose('取消置顶')
    await older.getByText('置顶', { exact: true }).waitFor({ state: 'hidden' })
    const titles = await history.allTextContents()
    assert.ok(titles.findIndex(text => text.includes('Newer chat')) < titles.findIndex(text => text.includes('Older chat')))
    await choose('置顶')
    await history.first().getByText('Older chat', { exact: true }).waitFor()
    await choose('归档会话')
    await older.waitFor({ state: 'hidden' })
    await page.reload()
    await openSidebar()
    assert.equal(await older.count(), 0)

    await archive.click()
    await older.waitFor()
    const search = page.getByPlaceholder('搜索归档…')
    await search.fill('missing')
    await older.waitFor({ state: 'hidden' })
    await search.fill('older')
    await older.click()
    await page.getByText('Keep this answer', { exact: true }).waitFor()
    await openSidebar()
    if (await archive.getAttribute('aria-pressed') === 'false') await archive.click()
    await choose('恢复会话')
    await older.waitFor({ state: 'hidden' })
    await archive.click()
    await older.waitFor()
    assert.equal(await older.getByText('置顶', { exact: true }).count(), 0)
    await page.close()
    console.log('PASS ' + width + 'px chat pin, unpin, archive, search, open, restore and reload')
  }
} finally {
  await browser.close()
}
