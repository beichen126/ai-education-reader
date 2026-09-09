import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'src', 'help', 'product-guide.md')
const readmePath = path.join(root, 'README.md')
const source = fs.readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n').trim()
const readme = fs.readFileSync(readmePath, 'utf8').replaceAll('\r\n', '\n')
const startHeading = '## 产品一句话介绍'
const endHeading = '## 功能亮点'
const start = readme.indexOf(startHeading)
const end = readme.indexOf(endHeading)
const embedded = start >= 0 && end > start
  ? readme.slice(start, end).trim()
  : ''

const checks = [
  ['README guide headings exist and are ordered', embedded !== ''],
  ['README guide block exactly matches source', embedded === source],
  ['guide has product explanation', source.includes('## 产品一句话介绍')],
  ['guide explains first screen is AI conversation', source.includes('第一屏就是 **AI 对话**')],
  ['guide explains Zotero difference', source.includes('打开 Zotero，你先面对一页 PDF；打开本产品，你先面对一场 AI 对话')],
  ['guide explains attachment return path', source.includes('左侧边栏回到已经发送的图片、PDF')],
  ['guide has 18 FAQ entries', (source.match(/^### \d+\. /gm) || []).length >= 18],
  ['guide contains no raw HTML or script', !/<\/?script\b|\bon[a-z]+\s*=/i.test(source)],
]
let failed = 0
for (const [label, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failed += 1
}
console.log(`SUMMARY ${checks.length - failed}/${checks.length} passed`)
process.exit(failed === 0 ? 0 : 1)
