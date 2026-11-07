import assert from 'node:assert/strict'
import { parseGenUi, GENUI_PROMPT } from '../src/genui/schema'
assert.equal(parseGenUi('{"items":[{"type":"text","content":"hello"}]}').length, 1)
for (const value of ['{}', '{', '{"items":[{"type":"script"}]}', '{"items":[{"type":"quiz","options":[null]}]}', '{"items":[{"type":"tabs","tabs":[null]}]}', '{"items":[{"type":"input","id":"__proto__"}]}', '{"items":[{"type":"table","columns":[],"rows":[null]}]}']) {
  assert.throws(() => parseGenUi(value), value)
}
assert.throws(() => parseGenUi(' '.repeat(64001)))
assert.throws(() => parseGenUi(JSON.stringify({items:Array.from({length:161},()=>({type:'text'}))})))
let node: any = { type: 'text' }
for(let i=0;i<10;i++) node={type:'card',items:[node]}
assert.throws(() => parseGenUi(JSON.stringify({items:[node]})))
assert.match(GENUI_PROMPT, /dsh-ui/)
console.log('GenUI schema: valid, malformed, unsafe types, budgets and nesting passed')

const { appendGenUiGuidance, projectLogicalPromptContext } = await import('../src/prompts/prompt-compile-strategies')
const { buildFlattenedPromptSummary } = await import('../src/prompts/prompt-compile-strategies')
const original = { role: 'user' as const, content: 'Explain this' }
const messages = [original]
appendGenUiGuidance(messages)
assert.equal(original.content, 'Explain this')
assert.equal(messages[0].role, 'user')
assert.match(messages[0].content, /Reader rendering capabilities/)
const parts = [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,YQ==' } }]
const multimodal: any[] = [{role:'user',content:parts}]
appendGenUiGuidance(multimodal)
assert.equal(parts.length, 1)
assert.deepEqual(multimodal[0].content[0], parts[0])
assert.equal(multimodal[0].content.length, 2)
const timeline = buildFlattenedPromptSummary([])
const framed: any[] = [{role:'system',content:timeline},{role:'user',content:'Question'}]
appendGenUiGuidance(framed)
assert.equal(framed[0].content,timeline)
assert.doesNotThrow(()=>JSON.parse(framed[0].content.slice('Prompt Timeline\n'.length)))
const context: any = {domain:'conversation',messages:[{id:'u',role:'user',content:'Question',images:[]}],segments:[],transitions:[],bindings:[]}
for(const policy of ['flattened','interleaved'] as const) {
 const projected = await projectLogicalPromptContext(context,policy,undefined,{genUi:true})
 assert.equal(projected.some(m=>m.role==='system'),false)
 assert.match(String(projected[0].content),/Reader rendering capabilities/)
 assert.equal(context.messages[0].content,'Question')
 const ordinary = await projectLogicalPromptContext(context,policy)
 assert.equal(ordinary[0].content,'Question')
}
const structured = await projectLogicalPromptContext({...context,domain:'artifact'},'flattened',undefined,{genUi:true})
assert.equal(structured[0].content,'Question')
console.log('GenUI prompt projection: empty default, timeline JSON, immutability, images and protocol isolation passed')
