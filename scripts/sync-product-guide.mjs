import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'src', 'help', 'product-guide.md')
const readmePath = path.join(root, 'README.md')
const startHeading = '## 产品一句话介绍'
const endHeading = '## 功能亮点'

function read(file) {
  return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
}

const source = read(sourcePath).trim()
const readme = read(readmePath)
const start = readme.indexOf(startHeading)
const end = readme.indexOf(endHeading)
if (start < 0 || end < 0 || end <= start) throw new Error('README product guide headings are missing or out of order')

const before = readme.slice(0, start)
const after = readme.slice(end)
const next = `${before}${source}\n\n${after}`
if (next === readme) {
  console.log('Product Guide already matches README source')
} else {
  fs.writeFileSync(readmePath, next)
  console.log('Synced README product guide from ' + path.relative(root, sourcePath))
}
