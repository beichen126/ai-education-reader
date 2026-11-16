import {OMITTED_GENUI_TYPES} from '../src/genui/catalog-policy.ts'
import {compileMathExprProgram} from '../node_modules/@changfenhuang/dsh-genui/src/client/safe-math.ts'
import {cardTemplates} from '../src/genui/card-templates.ts'
import assert from 'node:assert/strict'
import {processGenuiSpec,isRenderableProcess} from '../node_modules/@changfenhuang/dsh-genui/src/client/guard.ts'
import {genuiTemplates} from '../node_modules/@changfenhuang/dsh-genui/src/client/templates.ts'
import {GENUI_NATIVE_TYPES} from '../node_modules/@changfenhuang/dsh-genui/src/client/genui-runtime/schema.ts'
import {fixtures} from './genui-full-fixtures.mjs'
import {FULL_GENUI_PROMPT} from '../src/genui/catalog-prompt.ts'
import {normalizeGenuiInput} from '../src/genui/normalize-input.ts'
const brokenCard = {items:[{type:'card',title:'Luna · Gemini 3.8 Flash',accent:true,items:[{type:'keyvalue',pairs:[{key:'模型',value:'Gemini'}]}]}]}
assert.equal(isRenderableProcess(processGenuiSpec(brokenCard)),false)
assert.ok(isRenderableProcess(processGenuiSpec(normalizeGenuiInput(brokenCard))))
assert.equal(brokenCard.items[0].accent,true,'keep original source intact')
assert.equal(normalizeGenuiInput({items:[{type:'card',accent:false,items:[]}]}).items[0].accent,undefined)
assert.equal(normalizeGenuiInput({items:[{type:'json',value:brokenCard}]}).items[0].value,brokenCard,'do not rewrite data payloads')
assert.ok(!isRenderableProcess(processGenuiSpec(normalizeGenuiInput({items:[{type:'card',accent:true,items:'invalid'}]}))))
assert.ok(FULL_GENUI_PROMPT.includes('accent:string,flat:boolean'))
for(const [name,raw] of Object.entries(fixtures)){const {schema,...spec}=raw as any;const result=processGenuiSpec(spec);assert.ok(isRenderableProcess(result),name+': '+result.errors.join(';'))}
for(const t of [...cardTemplates,...genuiTemplates()]){const result=processGenuiSpec(t.demo);assert.ok(isRenderableProcess(result),t.id+': '+result.errors.join(';'))}
for(const name of GENUI_NATIVE_TYPES)assert.equal(FULL_GENUI_PROMPT.includes('\n'+name+': '),!OMITTED_GENUI_TYPES.has(name),name+' follows generation policy')
assert.ok(!isRenderableProcess(processGenuiSpec({items:[{type:'script',content:'alert(1)'}]})))
assert.equal(compileMathExprProgram('window.location=1'),null)
console.log('PASS '+GENUI_NATIVE_TYPES.size+' catalog types, '+genuiTemplates().length+' templates, functional fixtures and unsafe-component guards')
