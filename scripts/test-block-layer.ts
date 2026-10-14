import { parseMarkdown } from '../src/markdown/parse.ts'
import { buildBlockModels, flattenText } from '../src/markdown/block-layer.ts'
import { mathSummary } from './fixtures/math-summary.mjs'
import { leverageParagraph } from './fixtures/currency.mjs'
import { multilineDollarMath } from './fixtures/multiline-dollar-math.mjs'
let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const md = '# 第五章 存储\n\n**平均存储器**访问时间，见[链接](https://x)与*斜体*。\n\n- 列表项A\n- 列表项B\n\n> 重要引用\n\n| 概念 | 含义 |\n|---|---|\n| AMAT | **平均**访问 |\n\n```js\nconst a = 1\n```'
const mid = 'msg-abc'
const root = parseMarkdown(md)
const blocks = buildBlockModels(root, mid)

// 1) block count and types cover all supported kinds
const types = blocks.map(b=>b.type)
assert(types.includes('heading'), 'heading block present')
assert(types.includes('paragraph'), 'paragraph block present')
assert(types.includes('list-item'), 'list-item blocks present')
assert(types.includes('blockquote'), 'blockquote block present')
assert(types.includes('table'), 'table block present')
assert(types.includes('code'), 'code block present')

// 2) blockId derives from messageId + source position (not DOM order)
const p = blocks.find(b=>b.type==='paragraph')
const para = root.children.find((c:any)=>c.type==='paragraph')
assert(p.id === (mid + '/p-' + para.position.start.offset + '-' + para.position.end.offset), 'paragraph blockId = msg + type + sourceStart + sourceEnd => ' + p.id)

// 3) canonicalText excludes inline markup
assert(p.canonicalText === '平均存储器访问时间，见链接与斜体。', 'paragraph canonicalText strips strong/link/em => ' + JSON.stringify(p.canonicalText))

// 4) heading has correct canonical + source
const h = blocks.find(b=>b.type==='heading')
assert(h.canonicalText === '第五章 存储', 'heading canonical => ' + JSON.stringify(h.canonicalText))

// 5) list-item count
const lis = blocks.filter(b=>b.type==='list-item')
assert(lis.length === 2 && lis[0].canonicalText === '列表项A' && lis[1].canonicalText === '列表项B', 'two list items with own canonical')

// 6) blockquote canonical
const quote = blocks.find(b=>b.type==='blockquote')
assert(quote.canonicalText === '重要引用', 'blockquote canonical => ' + JSON.stringify(quote.canonicalText))

// 7) table block has tableId + rows + cols; cells source positions exist
const table = blocks.find(b=>b.type==='table')
const tblNode = root.children.find((c:any)=>c.type==='table')
assert(!!table.table && table.table.id === (mid + '/table-' + tblNode.position.start.offset + '-' + tblNode.position.end.offset), 'tableId from source position => ' + table.table.id)
assert(table.table.rows === 2 && table.table.cols === 2, 'table rows/cols = 2x2')

// 8) code block is ordinary annotatable canonical text
const code = blocks.find(b=>b.type==='code')
assert(code.annotatable === true, 'code block annotatable = true')
assert(code.canonicalText === 'const a = 1', 'code canonical = code text')

// 9) paragraphs/blocks annotatable by default
assert(p.annotatable === true, 'paragraph annotatable = true')

// 10) flattenText helper drops inline markup
const paraNode = root.children.find((c:any)=>c.type==='paragraph')
assert(flattenText(paraNode) === '平均存储器访问时间，见链接与斜体。', 'flattenText output')

// 11) refresh stability: parse the SAME content again -> blockIds identical
const blocks2 = buildBlockModels(parseMarkdown(md), mid)
assert(blocks.map(b=>b.id).join('|') === blocks2.map(b=>b.id).join('|'), 'blockIds stable across re-parse')

// CJK-adjacent bold (DSH cjkFriendlyStrong): bold closes after punctuation when CJK prose continues.
const cjkRoot = parseMarkdown('**平均存储器访问时间（AMAT）**值')
let cjkStrong = false
;(function w(ns: any[]){ for (const n of ns) { if (n.type === 'strong') cjkStrong = true; if (n.children) w(n.children) } })((cjkRoot.children as any))
assert(cjkStrong, 'bold adjacent to CJK after punctuation (**（AMAT）**值) renders a strong node')
const cjkText = flattenText((cjkRoot.children as any).find((c: any) => c.type === 'paragraph'))
assert(!cjkText.includes('**'), 'no literal ** remains in the CJK-adjacent bold paragraph')

const summaryRoot = parseMarkdown(mathSummary)
const summaryTable = summaryRoot.children.find((node: any) => node.type === 'table') as any
assert(summaryTable.children.length === 4 && summaryTable.children.every((row: any) => row.children.length === 2), 'TeX absolute-value pipes do not split summary table cells')
const summaryMath: any[] = []
;(function walk(node: any) { if (node.type === 'inlineMath') summaryMath.push(node); node.children?.forEach(walk) })(summaryRoot)
const absoluteMath = summaryMath.find(node => node.value === String.raw`\int|f|`)
assert(!!absoluteMath, 'absolute-value formula remains an inline math node')
assert(mathSummary.slice(absoluteMath?.position.start.offset, absoluteMath?.position.end.offset) === String.raw`\(\int|f|\)`, 'math positions still point to the exact original source')
assert(summaryTable.children[3].children[1].children.some((node: any) => node.type === 'strong'), 'bold around the formula remains intact')
for (const formulaSource of [String.raw`$|x|$`, String.raw`\(\left|x\right|\)`, String.raw`$\|x\|$`, String.raw`$a|b|c$`]) {
  const sample = '| A | B |\n|---|---|\n| value | ' + formulaSource + ' |'
  const parsed = parseMarkdown(sample)
  const table = parsed.children[0] as any
  assert(table.type === 'table' && table.children[1].children.length === 2 && table.children[1].children[1].children[0].type === 'inlineMath', 'table math pipe compatibility: ' + formulaSource)
}
const plainPipes = parseMarkdown('| A | B |\n|---|---|\n| a | b | c |').children[0] as any
assert(plainPipes.children[1].children.length === 3, 'ordinary table separators are unchanged')
const fenced = parseMarkdown('```tex\n$|x|$\n```').children[0] as any
assert(fenced.type === 'code' && fenced.value === '$|x|$', 'code content is unchanged')

const currencyRoot = parseMarkdown(leverageParagraph)
assert(flattenText(currencyRoot) === leverageParagraph, 'financial prose preserves every dollar sign and space instead of becoming math')
for (const sample of ['Pay $100 and $90, then calculate $x^2$.', 'Amounts $1,000.50 and $20.25; formula $2x + 1$.', 'Pay $100-$90, then $10; equation $100 + 20$.', 'Loss $-100 and cost $.50; formula $-2x$.']) {
  const nodes: any[] = []
  ;(function walk(node: any) { if (node.type === 'inlineMath') nodes.push(node); node.children?.forEach(walk) })(parseMarkdown(sample))
  assert(nodes.length === 1, 'mixed currency and genuine math: ' + sample)
  assert(sample.slice(nodes[0].position.start.offset, nodes[0].position.end.offset) === '$' + nodes[0].value + '$', 'mixed math retains original source positions')
}
const currencyTable = parseMarkdown('| Cost | Debt | Formula |\n|---|---|---|\n| $100 | $90 | $x + 1$ |').children[0] as any
assert(currencyTable.children[1].children.length === 3, 'currency across table cells never hides real column separators')
assert(currencyTable.children[1].children[0].children[0].value === '$100', 'currency in a table stays literal')
for (const formula of ['$100$', '$100 + 20$', '$2 xy$', '$100 sin x$', '$$100$$', String.raw`\(100\)`]) {
  assert(flattenText(parseMarkdown('Formula: ' + formula)).includes('\uFFFF'), 'explicit numeric math remains supported: ' + formula)
}
const dollarRoot = parseMarkdown(multilineDollarMath)
const dollarBlocks = dollarRoot.children.filter((node: any) => node.type === 'math') as any[]
assert(dollarBlocks.length === 9, 'attached multiline dollar delimiters produce nine separate formulas')
assert(dollarBlocks[0].value.startsWith(String.raw`I=\int_0^{\pi/2}`), 'opening-line TeX remains formula content instead of metadata')
assert(dollarBlocks.every(node => !node.meta && !node.value.includes('部分分式') && !node.value.includes('积分：')), 'formula boundaries do not swallow surrounding prose')
assert(dollarBlocks.every(node => multilineDollarMath.slice(node.position.start.offset, node.position.end.offset).startsWith('$$') && multilineDollarMath.slice(node.position.start.offset, node.position.end.offset).endsWith('$$')), 'formula positions preserve attached source delimiters')
assert(flattenText(dollarRoot.children.at(-1)).startsWith('总结：'), 'final summary stays ordinary Markdown')
for (const sample of ['$$\nx=1\n$$', '$$x=1\n+y=2\n$$', '$$\nx=1\n+y=2$$']) {
  const formula = parseMarkdown(sample).children[0] as any
  assert(formula.type === 'math' && formula.value.includes('x=1') && !formula.value.includes('$$'), 'standalone and mixed multiline dollar delimiters remain supported')
}
console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
