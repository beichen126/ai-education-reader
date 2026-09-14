import { estimateContextUsage, estimateTextTokens, formatEstimatedTokens } from '../src/engine/context-usage.ts'

let pass = 0, fail = 0
function assert(value: boolean, label: string) { if (value) { pass++; console.log('  ok: ' + label) } else { fail++; console.log('  FAIL: ' + label) } }

assert(estimateTextTokens('测试') === 2, 'CJK text uses a dense estimate')
assert(estimateTextTokens('abcd') === 1, 'Latin text uses the characters / 4 estimate')
const usage = estimateContextUsage({ messages: [{ role: 'user', content: 'first', images: ['old-1', 'old-2'] }, { role: 'assistant', content: '回答', images: [] }, { role: 'user', content: 'latest', images: ['new-1'] }], draftText: '草稿', promptTexts: ['prompt'], systemPrompt: 'system' })
assert(usage.imageCount === 1, 'only the newest image-bearing turn is counted')
assert(usage.messageCount === 4, 'non-empty draft counts as the pending message')
const draftUsage = estimateContextUsage({ messages: [{ role: 'user', content: '', images: ['old'] }], draftImageIds: ['draft-1', 'draft-2'] })
assert(draftUsage.imageCount === 2, 'draft images take precedence over historical images')
assert(formatEstimatedTokens(999) === '999', 'small token values stay exact')
assert(formatEstimatedTokens(3200) === '3.2K', 'thousands use compact display')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
