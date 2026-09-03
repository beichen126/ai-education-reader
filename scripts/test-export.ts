import 'fake-indexeddb/auto'
import { parseMarkdown } from '../src/markdown/parse.ts'
import { buildBlockModels, blockIdOf, tableIdOf, startOf, endOf } from '../src/markdown/block-layer.ts'
import { conversationMarkdown, markedOnlyMarkdown } from '../src/export/markdown.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup, BackupError } from '../src/export/backup-import.ts'
import { setSetting, saveConversation, saveAnnotation, getConversation, getAnnotationsByMessage, listConversations } from '../src/storage/storage.ts'
import { saveAttachment, getAttachmentRow } from '../src/storage/storage.ts'
import { idbReplaceAll } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'
import type { Annotation } from '../src/annotations/annotation-types.ts'
import type { Conversation, Message, Attachment } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(cond: boolean, msg: string){ if(cond){ pass++; console.log('  ok: '+msg) } else { fail++; console.log('  FAIL: '+msg) } }

function makeConv(id: string, title: string, messages: Message[]): Conversation { return { id, title, createdAt: 1, updatedAt: 1, messages } }
function textAnn(conv: string, mid: string, blockId: string, start: number, end: number, exact: string, prefix = '', suffix = ''): Annotation {
  return { id: newStableId(), conversationId: conv, messageId: mid, createdAt: 1, updatedAt: 1, version: 1, target: { type: 'text', anchor: { scope: 'block', blockId }, start, end, quote: { exact, prefix, suffix } } }
}
function tableAnn(conv: string, mid: string, tableId: string, partial: 'whole' | 'cells' | 'cell' = 'whole'): Annotation {
  if (partial === 'whole') return { id: newStableId(), conversationId: conv, messageId: mid, createdAt: 1, updatedAt: 1, version: 1, target: { type: 'table', tableId } }
  if (partial === 'cells') return { id: newStableId(), conversationId: conv, messageId: mid, createdAt: 1, updatedAt: 1, version: 1, target: { type: 'table-cells', tableId, bounds: { rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 } } }
  return { id: newStableId(), conversationId: conv, messageId: mid, createdAt: 1, updatedAt: 1, version: 1, target: { type: 'text', anchor: { scope: 'table-cell', tableId, row: 1, column: 0 }, start: 0, end: 2, quote: { exact: '', prefix: '', suffix: '' } } }
}
function paraInfo(content: string, mid: string) { const root = parseMarkdown(content); const models = buildBlockModels(root, mid); return { root, models } }

console.log('=== Markdown export ===')
// 1) no annotation
const c0 = '普通文本**加粗**。'
const conv0 = makeConv('c0','无标注',[{ id:'m0', role:'assistant', content:c0, images:[], createdAt:1, updatedAt:1 }])
assert(conversationMarkdown(conv0, []).includes('普通文本**加粗**。'), 'no annotation -> content unchanged')

// 2) single mark inside strong
const md1 = '这是**重点**内容。'
const { models: mm1 } = paraInfo(md1, 'm1')
const ann1 = [textAnn('c1','m1', mm1[0].id, 2, 4, '重点', '这是', '内容')]
const full1 = conversationMarkdown(makeConv('c1','单标',[{ id:'m1', role:'assistant', content:md1, images:[], createdAt:1, updatedAt:1 }]), ann1)
assert(full1.includes('这是**<mark>重点</mark>**内容。'), 'single mark inside strong -> ' + full1.split('\n').find(x=>x.includes('这是')))

// 3) link内标记
const mdl = '见[资料](https://x)。'
const { models: mml } = paraInfo(mdl, 'm2')
const annl = [textAnn('c2','m2', mml[0].id, 1, 3, '资料', '见', '。')]
const full2 = conversationMarkdown(makeConv('c2','链',[{ id:'m2', role:'assistant', content:mdl, images:[], createdAt:1, updatedAt:1 }]), annl)
assert(full2.includes('[<mark>资料</mark>](https://x)'), 'link内标记 -> ' + full2.split('\n').find(x=>x.includes('见')))

// 4) Chinese + mark
const mzc = '缓存利用时间局部性提高访问速度。'
const { models: mmz } = paraInfo(mzc, 'm3')
const annz = [textAnn('c3','m3', mmz[0].id, 4, 9, '时间局部性', '缓存利用', '提高访问速度。')]
assert(conversationMarkdown(makeConv('c3','中文',[{ id:'m3', role:'assistant', content:mzc, images:[], createdAt:1, updatedAt:1 }]), annz).includes('缓存利用<mark>时间局部性</mark>提高访问速度。'), 'Chinese whole-para mark')

// 5) emoji UTF-16 (astral: 😀 = 2 code units)
const memo = '前😀后文本。'
const { models: mme } = paraInfo(memo, 'm4')
// canonical chars: 前(1) 😀(2 units) 后(1)...
const annE = [textAnn('c4','m4', mme[0].id, 3, 4, '后', '前😀', '文本。')]
assert(conversationMarkdown(makeConv('c4','emoji',[{ id:'m4', role:'assistant', content:memo, images:[], createdAt:1, updatedAt:1 }]), annE).includes('前😀<mark>后</mark>文本。'), 'emoji UTF-16 offsets preserved')

// 6) repeated same text -> mark only the target occurrence via offsets
const mrep = '缓存缓存缓存。'
const { models: mmr } = paraInfo(mrep, 'm5')
// canonical 缓存缓存缓存。 annotation on 2nd 缓存: start 2, end 4
const annR = [textAnn('c5','m5', mmr[0].id, 2, 4, '缓存', '缓存', '缓存。')]
const fullR = conversationMarkdown(makeConv('c5','重复',[{ id:'m5', role:'assistant', content:mrep, images:[], createdAt:1, updatedAt:1 }]), annR)
const markedR = fullR.split('\n').find(x=>x.includes('缓存'))
assert(markedR === '缓存<mark>缓存</mark>缓存。', 'repeated text marks only target occurrence -> ' + markedR + ' (count of <mark>: ' + (markedR.match(/<mark>/g)||[]).length + ')')

// 7) table annotations -> keep whole table via markers
const mtab = '# 表\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'
const { models: mmt } = paraInfo(mtab, 'm6')
const table = mmt.find(b => b.type === 'table')!
const tblId = table.table!.id
const kind = tableAnn('c6','m6', tblId, 'whole')
const fullT = conversationMarkdown(makeConv('c6','表格',[{ id:'m6', role:'assistant', content:mtab, images:[], createdAt:1, updatedAt:1 }]), [kind])
assert(fullT.includes('<!-- marked-table:start -->') && fullT.includes('| A | B |') && fullT.includes('<!-- marked-table:end -->'), 'whole-table -> marker wrappers + full table kept')

// 8) table cells rectangle -> keep table
const kind2 = tableAnn('c6','m6', tblId, 'cells')
assert(conversationMarkdown(makeConv('c6','表格',[{ id:'m6', role:'assistant', content:mtab, images:[], createdAt:1, updatedAt:1 }]), [kind2]).includes('<!-- marked-table:start -->'), 'table-cells rectangle -> table kept')

// 9) cell text annotation -> keep table
const kind3 = tableAnn('c6','m6', tblId, 'cell')
assert(conversationMarkdown(makeConv('c6','表格',[{ id:'m6', role:'assistant', content:mtab, images:[], createdAt:1, updatedAt:1 }]), [kind3]).includes('<!-- marked-table:start -->'), 'cell text annotation -> table kept')

// 10) marked-only excludes unmarked text, keeps heading context
const mh = '# 操作系统\n\n## 虚拟内存\n\n缺页异常发生时，会触发中断。\n'
const { models: mmh } = paraInfo(mh, 'm7')
const par = mmh.find(b => b.type === 'paragraph')!
const annH = [textAnn('c7','m7', par.id, 0, 4, '缺页异常', '', '发生')]
const mo = markedOnlyMarkdown(makeConv('c7','标',[{ id:'m7', role:'assistant', content:mh, images:[], createdAt:1, updatedAt:1 }]), annH)
assert(mo.includes('## AI · 操作系统 > 虚拟内存'), 'marked-only heading context -> ' + mo.split('\n').find(x=>x.startsWith('## AI')))
assert(mo.includes('<mark>缺页异常</mark>'), 'marked-only excerpt present')
assert(!mo.includes('会触发中断'), 'marked-only excludes unmarked text')

// 11) marked-only multiple messages keeps role context
const mm1b = '# 会话\n\n章一文本。\n'
const { models: mmm } = paraInfo(mm1b, 'm8')
const annM = [textAnn('c8','m8', mmm[0].id, 0, 4, '章一文本', '', '')]
const mo2 = markedOnlyMarkdown(makeConv('c8','多消息',[{ id:'m8', role:'assistant', content:mm1b, images:[], createdAt:1, updatedAt:1 }]), annM)
assert(mo2.includes('## AI'), 'marked-only role context AI')

// 12) LaTeX source not polluted (export uses Message.content raw)
const math = '公式 $$E=mc^2$$ 保留。'
assert(conversationMarkdown(makeConv('c9','数学',[{ id:'m9', role:'assistant', content:math, images:[], createdAt:1, updatedAt:1 }]), []).includes('$$E=mc^2$$'), 'LaTeX source preserved, no KaTeX HTML')

console.log('=== Backup ===')
const proto = newStableId()
const bAid = 'conv-backup'
const bMsg: Message = { id: 'msg-backup', role: 'assistant', content: '备份内容', images: ['att-backup'], createdAt: 1, updatedAt: 1 }
const bConv: Conversation = { id: bAid, title: '备份会话', createdAt: 1, updatedAt: 1, messages: [bMsg] }
const bAnn = textAnn(bAid, 'msg-backup', 'fake-block', 0, 2, '备份')
await setSetting('apiBaseUrl', 'https://api.deepseek.com')
await setSetting('model', 'deepseek-chat')
await setSetting('customSystemPrompt', '固定提示词')
await setSetting('customSystemPromptEnabled', 'true')
await setSetting('apiKey', 'secret-key-should-not-export')
await saveConversation(bConv)
const attMeta: Attachment = { id: 'att-backup', name: 'b.png', mimeType: 'image/png', size: 4, createdAt: 1, updatedAt: 1 }
await saveAttachment(attMeta, new Blob([new Uint8Array([1,2,3,4])], { type: 'image/png' }))
await saveAnnotation(bAnn)
const backup = await buildBackup()
assert(!('apiKey' in backup.settings), 'buildBackup settings excludes apiKey')
assert(backup.settings.customSystemPromptEnabled === true, 'backup keeps customSystemPromptEnabled')
assert(backup.settings.customSystemPrompt === '固定提示词', 'backup keeps customSystemPrompt')
assert(backup.conversations.length === 1 && backup.conversations[0].id === bAid, 'backup includes conversation')
assert(backup.annotations.length === 1 && backup.annotations[0].conversationId === bAid, 'backup includes annotation')
assert(backup.attachments.length === 1 && backup.attachments[0].meta.id === 'att-backup', 'backup includes attachment meta')
const base64 = backup.attachments[0].data
const bytes = Buffer.from(base64, 'base64')
assert(bytes.length === 4 && bytes[0] === 1 && bytes[3] === 4, 'attachment base64 decodes to original bytes')

// round-trip: clear DB then restore
await idbReplaceAll({ settings: [], conversations: [], attachments: [], annotations: [] })
await restoreBackup(backup)
const convAfter = await getConversation(bAid)
assert(!!convAfter && convAfter.messages[0].content === '备份内容' && convAfter.messages[0].images[0] === 'att-backup', 'conversation restored with stable ids')
const annAfter = await getAnnotationsByMessage(bAid, 'msg-backup')
assert(annAfter.length === 1 && annAfter[0].target.anchor.scope === 'block', 'annotation restored')
const rowAfter = await getAttachmentRow('att-backup')
const afterBlob = rowAfter && rowAfter.binary && rowAfter.binary.storage === 'idb' ? rowAfter.binary.blob : rowAfter?.blob
const bytesAfter = new Uint8Array(await (afterBlob as Blob).arrayBuffer())
assert(rowAfter && bytesAfter.length === 4 && bytesAfter[0] === 1 && bytesAfter[3] === 4, 'attachment bytes restored identically')

// validate rejects
let threw = false
try { parseAndValidate({ format: 'nope', version: 1, conversations: [], annotations: [], attachments: [] }) } catch(e){ threw = e instanceof BackupError }
assert(threw, 'parseAndValidate rejects wrong format')
threw = false
try { parseAndValidate({ format: 'ai-education-reader-backup', version: 99, conversations: [], annotations: [], attachments: [] }) } catch(e){ threw = e instanceof BackupError }
assert(threw, 'parseAndValidate rejects wrong version')
threw = false
try { parseAndValidate({ format: 'ai-education-reader-backup', version: 1 }) } catch(e){ threw = e instanceof BackupError }
assert(threw, 'parseAndValidate rejects missing arrays')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)