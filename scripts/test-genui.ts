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
