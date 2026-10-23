import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
import { openSettings, openDocumentLibrary } from './e2e-navigation.mjs'
const browser = await launchBrowser()
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 }, hasTouch: true })
  await seedAndBoot(page, {})
  await openSettings(page, 'api')
  assert.equal(await page.evaluate(() => window.__readerBack()), true)
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'hidden' })
  await page.waitForTimeout(100)
  await openDocumentLibrary(page)
  await page.goBack()
  await page.getByTestId('document-library').waitFor({ state: 'hidden' })
  assert.ok(page.url().includes('ai-education-reader'))
  await openDocumentLibrary(page)
  await page.evaluate(() => {
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [new Touch({identifier:1,target:document.body,clientX:5,clientY:250})] }))
    document.dispatchEvent(new TouchEvent('touchend', {changedTouches:[new Touch({identifier:1,target:document.body,clientX:120,clientY:255})]}))
  })
  await page.getByTestId('document-library').waitFor({ state: 'hidden' })
  console.log('PASS: native back callback, browser back and edge swipe close overlays without leaving Reader')
} finally { await browser.close() }
