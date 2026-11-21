import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'

const browser = await launchBrowser()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const requests = []
  let ocrCount = 0
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': '*' }
  await page.route('**/v1/tools/ocr', route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    return route.fulfill({ headers: cors, json: {
      object: 'ocr.result', page_count: 1, pages: [{ index: 0, text: 'Project OCR marker ' + ++ocrCount, finish_reason: 'stop' }],
    } })
  })
  await page.route('**/chat/completions', route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    requests.push(route.request().postDataJSON())
    return route.fulfill({ headers: cors, json: { choices: [{ message: { content: '项目回答 ' + requests.length }, finish_reason: 'stop' }] } })
  })
  await seedAndBoot(page, { settings: { apiKey: 'sk-test' } })
  await page.getByTestId('sidebar-projects').click()
  await page.getByTestId('project-create').click()
  await page.getByLabel('项目名称').fill('哲学导论')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const heading = page.getByTestId('project-heading')
  await heading.getByText('哲学导论').waitFor()
  await heading.getByRole('button', { name: '项目资料', exact: true }).click()
  const gallery = page.getByTestId('gallery')
  await gallery.locator('input[accept=".pdf,application/pdf"]').setInputFiles('test/.playwright/outline-big.pdf')
  const pdf = page.getByRole('dialog', { name: 'PDF 本地预览' })
  await pdf.getByTestId('pdf-mode-manual').click()
  await pdf.getByTestId('pdf-start').fill('15')
  await pdf.getByTestId('pdf-end').fill('30')
  await pdf.getByTestId('pdf-generate').click()
  await pdf.getByTestId('pdf-add').click({ timeout: 60000 })
  await pdf.getByText('已固定 16 页', { exact: true }).waitFor()
  await pdf.getByRole('button', { name: '关闭', exact: true }).click()
  assert.equal(await gallery.locator('[data-project-material]').count(), 16)
  assert.equal(requests.length, 0)
  assert.equal(ocrCount, 16)
  await gallery.getByRole('button', { name: '关闭', exact: true }).click()
  await heading.getByTestId('project-new-chat').click()

  const send = async (question, reply) => {
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(question)
    await page.getByTestId('composer-send-stop').click()
    await page.getByText(reply, { exact: true }).waitFor()
  }
  await send('无附件问题', '项目回答 1')
  assert.doesNotMatch(JSON.stringify(requests[0]), /Project OCR marker|image_url/)
  await page.getByTestId('sidebar-entry-images').click()
  const page16 = gallery.locator('[data-project-material]').filter({ hasText: /第 16 页/ })
  await page16.getByRole('button', { name: '用于本次提问' }).click()
  assert.equal(await page16.getAttribute('data-selected'), 'true')
  assert.equal(await gallery.locator('[data-project-material]').count(), 16)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await gallery.evaluate(element => element.scrollWidth <= element.clientWidth))
  await page16.scrollIntoViewIfNeeded()
  await gallery.screenshot({ path: 'tmp/project-materials-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gallery.getByRole('button', { name: '关闭', exact: true }).click()
  await send('解释第 16 页', '项目回答 2')
  const body = JSON.stringify(requests[1])
  assert.match(body, /第 16 页/)
  assert.match(body, /Project OCR marker/)
  assert.equal(body.split('Project OCR marker').length - 1, 1)
  assert.doesNotMatch(body, /image_url|第 15 页|第 17 页/)
  await page.getByTestId('sidebar-entry-images').click()
  assert.equal(await page16.getAttribute('data-used'), 'true')
  assert.equal(await gallery.locator('[data-project-material]').count(), 16)
  assert.equal(await gallery.getByText('本会话附件', { exact: true }).count(), 0)
  await gallery.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload({ waitUntil: 'networkidle' })
  await heading.getByText('哲学导论').waitFor()
  await heading.getByTestId('project-new-chat').click()
  await page.getByTestId('sidebar-entry-images').click()
  await gallery.locator('[data-project-material]').last().waitFor()
  assert.equal(await gallery.locator('[data-project-material]').count(), 16)
  assert.equal(await gallery.locator('[data-project-material][data-selected]').count(), 0)
  assert.equal(await gallery.locator('[data-project-material][data-used]').count(), 0)
  await gallery.locator('input[accept^="image/"]').setInputFiles({
    name: 'notes.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  })
  await gallery.getByText('notes.png', { exact: true }).waitFor()
  await page.evaluate(() => {
    window.AndroidYoutube = { extract(id, videoId) {
      window.postMessage({ channel: 'reader-youtube-response', id, data: {
        videoId, title: '项目视频转写稿', language: 'en', fetchedAt: Date.now(), segments: [{ start: 5, duration: 1, text: 'Project video caption' }],
      } }, location.origin)
    } }
  })
  await gallery.getByRole('button', { name: '＋ YouTube', exact: true }).click()
  const youtube = page.getByRole('dialog', { name: 'YouTube 视频解析' })
  await youtube.getByLabel('视频链接').fill('https://youtu.be/abcdefghijk')
  await youtube.getByRole('button', { name: '提取字幕', exact: true }).click()
  await youtube.getByRole('button', { name: '固定到项目' }).click()
  await gallery.getByText('项目视频转写稿', { exact: true }).waitFor()
  assert.equal(await gallery.locator('[data-project-material]').count(), 18)
  assert.equal(requests.length, 2, 'saving an image or transcript does not call the chat model')
  const backup = await page.evaluate(async () => {
    const { buildBackup } = await import(location.pathname + 'src/export/backup-export.ts')
    const result = await buildBackup()
    window.__projectBackup = result
    const project = result.projects[0]
    return { saved: project.attachmentIds.length, attached: result.attachments.length,
      ocr: result.attachments.filter(item => item.meta.ocr).length,
      transcript: result.attachments.filter(item => item.meta.transcript).length,
      chats: result.conversations.filter(chat => chat.projectId === project.id).length }
  })
  assert.deepEqual(backup, { saved: 18, attached: 18, ocr: 16, transcript: 1, chats: 2 })
  await gallery.getByRole('button', { name: '关闭', exact: true }).click()
  await heading.getByRole('button', { name: '返回项目' }).click()
  const projectRow = page.getByTestId('project-row').filter({ hasText: '哲学导论' })
  const actions = projectRow.locator('..').getByRole('button', { name: '项目操作' })
  await actions.click()
  await page.getByRole('button', { name: '置顶', exact: true }).click()
  await projectRow.getByText('置顶', { exact: true }).waitFor()
  await actions.click()
  await page.getByRole('button', { name: '重命名', exact: true }).click()
  await page.getByLabel('项目名称').fill('哲学导论课')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await projectRow.getByText('哲学导论课', { exact: true }).waitFor()
  await actions.click()
  await page.getByRole('button', { name: '归档项目', exact: true }).click()
  await projectRow.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await actions.click()
  await page.getByRole('button', { name: '恢复项目', exact: true }).click()
  await projectRow.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await actions.click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await projectRow.locator('..').getByRole('button', { name: '删除', exact: true }).click()
  await projectRow.waitFor({ state: 'detached' })
  await page.getByTestId('sidebar-projects').click()
  assert.ok(await page.getByTestId('history-session').count() >= 2, 'deleting a project preserves its chats')
  await page.evaluate(async () => {
    const { parseAndValidate, restoreBackup } = await import(location.pathname + 'src/export/backup-import.ts')
    await restoreBackup(parseAndValidate(window.__projectBackup))
  })
  await page.reload({ waitUntil: 'networkidle' })
  await heading.getByText('哲学导论').waitFor()
  await page.getByTestId('sidebar-entry-images').click()
  await gallery.getByText('项目视频转写稿', { exact: true }).waitFor()
  assert.equal(await gallery.locator('[data-project-material]').count(), 18)
  console.log('PASS project PDF/OCR persists across chats and reload; only the selected page is sent, and the material tile is reused')
} finally { await browser.close() }
