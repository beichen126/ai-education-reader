import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot } from './e2e-fixture.mjs'
const browser = await launchBrowser()
try {
  for (const fail of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(({ fail }) => {
      window.nativePdfCalls = []
      const fetchOriginal = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        if (String(input).includes('/native-pdf/mock.jpg')) {
          const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 400
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ccddee'; ctx.fillRect(0, 0, 300, 400)
          ctx.fillStyle = '#345'; ctx.font = '20px sans-serif'; ctx.fillText('Native PDF surface', 20, 60)
          return new Response(await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg')))
        }
        return fetchOriginal(input, init)
      }
      window.AndroidPdf = {
        request(id, raw) {
          const request = JSON.parse(raw); window.nativePdfCalls.push(request.op)
          const result = request.op === 'render' ? fail ? { error: 'PDF_NATIVE_FAILED' } : { url: '/native-pdf/mock.jpg', width: 300, height: 400 } : {}
          setTimeout(() => window.postMessage({ channel: 'reader-pdf-response', id, ...result }, location.origin), 0)
        }, cancel() {},
      }
    }, { fail })
    await seedAndBoot(page, {})
    await page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first().click()
    await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-sample.pdf')
    await page.locator('[data-testid="document-reader"]').waitFor()
    await page.setViewportSize({ width: 412, height: 850 })
    await page.waitForFunction(() => window.nativePdfCalls.includes('render'))
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="document-reader"] canvas')].some(c => c.width > 10 && c.height > 10))
    await page.waitForFunction(fail => [...document.querySelectorAll('[data-testid="document-reader"] canvas')].some(c => {
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data
      if (!fail) return Math.abs(pixels[0]-204)<5 && Math.abs(pixels[1]-221)<5 && Math.abs(pixels[2]-238)<5 && pixels[3]===255
      for(let i=0;i<pixels.length;i+=4) if(pixels[i+3]===255 && pixels[i]<200 && pixels[i+1]<200 && pixels[i+2]<200)return true
      return false
    }), fail)
    assert.equal(await page.locator('[data-testid="document-reader"]').getByText('页面渲染失败。', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('PASS Android PDF bridge: native surface and automatic PDF.js fallback at mobile width')
} finally { await browser.close() }
