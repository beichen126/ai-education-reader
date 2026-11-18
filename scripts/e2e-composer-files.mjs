import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'

const browser = await launchBrowser()
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  let uploads = 0
  await page.route('https://api.deepseek.com/files', async route => {
    uploads++
    await route.fulfill({ json: { id: 'file-api-dropped', expires_at: Date.now() / 1000 + 3600 } })
  })
  await seedAndBoot(page, {
    convs: [{ id: 'files-test', title: 'File inputs', createdAt: 1, updatedAt: 1, messages: [] }],
    settings: { apiKey: 'test', model: 'deepseek-flash', lastConversationId: 'files-test' },
  })
  const composer = page.getByTestId('composer')
  const text = composer.getByRole('textbox', { name: '输入消息', exact: true })
  const pasteKey = process.platform === 'darwin' ? 'Meta+v' : 'Control+v'
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText('keep this draft'))
  await text.focus()
  await page.keyboard.press(pasteKey)
  await page.waitForFunction(() => document.querySelector('[data-testid="composer"] textarea')?.value === 'keep this draft')
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#48a'
    ctx.fillRect(0, 0, 8, 8)
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    window.dropPng = new Uint8Array(await png.arrayBuffer())
  })
  await page.keyboard.press(pasteKey)
  await composer.getByText('已添加 1 张图片').waitFor()
  assert.equal(await text.inputValue(), 'keep this draft')

  const scroll = page.getByTestId('conversation-scroll')
  const drop = async (files, checkHint = false) => {
    const data = await page.evaluateHandle(files => {
      const transfer = new DataTransfer()
      for (const file of files) transfer.items.add(new File([file.usePng ? window.dropPng : new Uint8Array(file.bytes)], file.name, { type: file.type }))
      return transfer
    }, files)
    await scroll.dispatchEvent('dragover', { dataTransfer: data })
    if (checkHint) await composer.getByText('松开鼠标添加文件').waitFor()
    await scroll.dispatchEvent('drop', { dataTransfer: data })
    await data.dispose()
  }
  await drop([{ name: 'dropped.png', type: '', usePng: true }], true)
  await composer.getByText('已添加 2 张图片').waitFor()
  await composer.getByText('松开鼠标添加文件').waitFor({ state: 'hidden' })

  const pdf = await readFile('test/fixtures/outline-sample.pdf')
  await drop([{ name: 'dropped.pdf', type: 'application/pdf', bytes: [...pdf] }])
  const preview = page.getByRole('dialog', { name: 'PDF 本地预览' })
  await preview.getByText('dropped.pdf', { exact: true }).waitFor()
  await preview.getByRole('button', { name: '关闭', exact: true }).click()

  await drop([{ name: 'notes.txt', type: 'text/plain', bytes: [65, 66, 67] }])
  const parsing = page.getByRole('dialog', { name: 'DeepSeek 文件解析' })
  await parsing.getByText('已拖入 1 份文档').waitFor()
  assert.equal(uploads, 0, 'dragging never starts a paid upload')
  await parsing.getByRole('button', { name: '上传拖入的文档' }).click()
  await parsing.getByRole('checkbox', { name: 'notes.txt' }).check()
  await parsing.getByRole('button', { name: /加入本次提问/ }).click()
  assert.equal(uploads, 1)
  await composer.getByRole('button', { name: '移除文件' }).waitFor()

  await drop([{ name: 'unsupported.exe', type: '', bytes: [0] }])
  await composer.getByRole('alert').getByText(/请拖入/).waitFor()
  assert.equal(await text.inputValue(), 'keep this draft')
  console.log('PASS composer real clipboard paste, file transfer events, local PDF preview and explicit document upload')
} finally {
  await browser.close()
}
