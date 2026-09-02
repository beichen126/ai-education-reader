import { parseMarkdown } from '../src/markdown/parse.ts'
import { buildBlockModels, flattenText } from '../src/markdown/block-layer.ts'
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

// 8) code block is NOT annotatable
const code = blocks.find(b=>b.type==='code')
assert(code.annotatable === false, 'code block annotatable = false')
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

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)