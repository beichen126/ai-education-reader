import {evaluateComputed} from '../node_modules/@changfenhuang/dsh-genui/src/client/computed.ts'
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

assert.equal(normalizeGenuiInput({items:[{type:'card',items:[]}]}).items[0].flat,true)
assert.equal(normalizeGenuiInput({items:[{type:'card',flat:false,items:[]}]}).items[0].flat,false)
assert.equal(normalizeGenuiInput({items:[{type:'col',items:[]}]}).items[0].gap,8)
assert.equal(normalizeGenuiInput({gap:12,items:[]}).gap,12)

const areaSpec:any={computed:[{id:'area',expr:'pi*radius^2'}],items:[{type:'card',title:'圆面积',items:[{type:'slider',id:'radius',value:2,min:0.1,max:10,step:0.1},{type:'stat',label:'面积',value:'{{area}}'}]}]}
assert.ok(isRenderableProcess(processGenuiSpec(areaSpec)))
assert.equal(evaluateComputed(areaSpec,{}).values.area,Math.PI*4)
assert.equal(evaluateComputed(areaSpec,{radius:'3'}).values.area,Math.PI*9)
assert.ok(evaluateComputed({...areaSpec,computed:[{id:'area',expr:'pi*r^2'}]},{}).errors.area)
assert.ok(evaluateComputed({...areaSpec,computed:[{id:'area',expr:'Math.PI*radius**2'}]},{}).errors.area)
assert.ok(!/历史|禁止|勿|不要|不得|不能|不生成|不执行|不索取/.test(FULL_GENUI_PROMPT),'generation instructions use affirmative wording')

const costSpec:any={computed:[{id:'area',expr:'width*height'},{id:'cost',expr:'area*unit_price',format:{maximumFractionDigits:2}}],items:[{type:'slider',id:'width',value:2,min:1,max:10},{type:'slider',id:'height',value:3,min:1,max:10},{type:'slider',id:'unit_price',value:5,min:1,max:20},{type:'stat',label:'费用',value:'{{cost}}'}]}
assert.ok(isRenderableProcess(processGenuiSpec(costSpec)))
assert.equal(evaluateComputed(costSpec,{}).values.cost,30)
assert.equal(evaluateComputed(costSpec,{width:'4'}).values.cost,60)

const unified=normalizeGenuiInput({items:[{type:'choices',mode:'multi',items:[{label:'A'},{label:'B'}],answer:['A','B'],submit:'提交选择'}]})
assert.ok(isRenderableProcess(processGenuiSpec(unified)))
assert.equal(unified.items[0].action,'reader-choices:1')
assert.ok(unified.items[0].answer.startsWith('__reader_multi__:'))
assert.equal(normalizeGenuiInput({items:[{type:'choices',items:[{label:'A'},{label:'A'}]}]}).items[0].items.length,1)
assert.equal(normalizeGenuiInput({items:[{type:'choices',items:[{label:'A'}],answer:'B'}]}).items[0].answer,undefined)

assert.deepEqual(normalizeGenuiInput(unified),unified,"unified choices survives JSON export/reimport")
