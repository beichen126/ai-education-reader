import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = path.join(root, 'README.md')
const readme = fs.readFileSync(readmePath, 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let pass = 0
let fail = 0
function expect(condition, message) {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

const headings = [
  '产品一句话介绍',
  '30 秒理解本产品',
  '设计哲学：PDF 是一等对象',
  '与 Zotero 等 PDF 阅读器有什么不同',
  '与 ChatGPT/DeepSeek 等 AI 网页端有什么不同',
  '第一次使用',
  '导入和阅读 PDF',
  '选择页面/章节加入对话',
  '自定义会话模式',
  '快捷追问',
  '整理笔记、生成摘要和生成题目',
  'AI 提取目录、检查并生成 PDF 书签',
  '页面笔记、消息标记和来源回链',
  '数据、隐私与备份',
  'FAQ',
  '当前限制与故障排查',
  '开发者信息',
]
for (const heading of headings) expect(readme.includes(heading), 'required user section: ' + heading)

const faq = readme.match(/## FAQ\n([\s\S]*?)(?=\n## |$)/)?.[1] || ''
const faqItems = faq.match(/^### \d+\. /gm) || []
expect(faqItems.length >= 18, 'FAQ has at least 18 numbered questions (got ' + faqItems.length + ')')
expect(readme.includes('摘要式笔记') && !/^### .*摘要成果/m.test(readme), 'summary is documented as Markdown, not a standalone artifact button')
expect(readme.includes('只有你选择的页面才会生成图片上下文') || readme.includes('只有你在 Context 中选择的页面'), 'selected PDF pages are the only model context')
expect(readme.includes('OPFS') && readme.includes('IndexedDB'), 'local binary storage facts are documented')
expect(readme.includes('API Key 不进入 Backup') && readme.includes('不进入 Backup JSON'), 'API key backup exclusion is documented')
expect(readme.includes('一次最多选择 **120 页**') && readme.includes('超过 **30 页**'), 'README includes product PDF limits')

const badge = new RegExp('status-v' + pkg.version.replaceAll('.', '\\.') + '-').test(readme)
expect(badge, 'status badge matches package version ' + pkg.version)

const imagePaths = [
  ...[...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]),
  ...[...readme.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]),
]
const localImagePaths = imagePaths.filter((imagePath) => !/^[a-z][a-z0-9+.-]*:/i.test(imagePath))
expect(localImagePaths.length === 5, 'README keeps five information-dense product screenshots (got ' + localImagePaths.length + ')')
for (const requiredImage of [
  'docs/assets/readme/v210-00-app-shell.webp',
  'docs/assets/readme/v210-02-document-library.webp',
  'docs/assets/readme/v210-03-document-context-picker.webp',
  'docs/assets/readme/v210-04-ai-toc-review.webp',
  'docs/assets/readme/v210-11-prompt-manager.webp',
]) {
  expect(localImagePaths.includes(requiredImage), 'README keeps key screenshot: ' + requiredImage)
}
expect(!/v210-(07-mobile|08-dark-mode|09-mobile-history-drawer|10-mobile-rail)/.test(readme), 'README does not use low-information mobile/rail screenshots')
for (const imagePath of imagePaths) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(imagePath)) continue
  const target = path.resolve(root, imagePath)
  expect(target.startsWith(root + path.sep) && fs.existsSync(target), 'image exists: ' + imagePath)
}

const localLinks = [...readme.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
for (const link of localLinks) {
  const fileTarget = link.split('#', 1)[0]
  const target = path.resolve(root, fileTarget)
  expect(target.startsWith(root + path.sep) && fs.existsSync(target), 'local link exists: ' + link)
}

const limits = fs.readFileSync(path.join(root, 'src/pdf/pdf-types.ts'), 'utf8')
expect(/PDF_CONTEXT_SOFT_WARNING_PAGES\s*=\s*30/.test(limits), 'source soft warning constant is 30')
expect(/MAX_PDF_CONTEXT_PAGES\s*=\s*120/.test(limits), 'source hard page limit constant is 120')

const order = (heading) => readme.indexOf('## ' + heading)
expect(order('产品一句话介绍') < order('与 Zotero 等 PDF 阅读器有什么不同') && order('与 Zotero 等 PDF 阅读器有什么不同') < order('FAQ'), 'README foregrounds product and core differences before FAQ')
expect(order('FAQ') < order('设计哲学：PDF 是一等对象') && order('设计哲学：PDF 是一等对象') < order('功能亮点') && order('功能亮点') < order('页面展示'), 'README puts FAQ/design before features and screenshots')
expect(readme.includes('打开 Zotero，你先面对一页 PDF；打开本产品，你先面对一场 AI 对话'), 'Zotero difference is stated in plain user language')
expect(readme.includes('网页端 AI 把附件和图片顶在聊天最上方') && readme.includes('左侧边栏回到已经发送的图片、PDF'), 'AI web difference explains attachment return path')

console.log(`SUMMARY ${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
