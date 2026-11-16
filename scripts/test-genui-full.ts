import {compileMathExprProgram} from '../node_modules/@changfenhuang/dsh-genui/src/client/safe-math.ts'
import assert from 'node:assert/strict'
import {processGenuiSpec,isRenderableProcess} from '../node_modules/@changfenhuang/dsh-genui/src/client/guard.ts'
import {genuiTemplates} from '../node_modules/@changfenhuang/dsh-genui/src/client/templates.ts'
import {GENUI_NATIVE_TYPES} from '../node_modules/@changfenhuang/dsh-genui/src/client/genui-runtime/schema.ts'
import {fixtures} from './genui-full-fixtures.mjs'
import {FULL_GENUI_PROMPT} from '../src/genui/catalog-prompt.ts'
for(const [name,raw] of Object.entries(fixtures)){const {schema,...spec}=raw as any;const result=processGenuiSpec(spec);assert.ok(isRenderableProcess(result),name+': '+result.errors.join(';'))}
for(const t of genuiTemplates()){const result=processGenuiSpec(t.demo);assert.ok(isRenderableProcess(result),t.id+': '+result.errors.join(';'))}
for(const name of GENUI_NATIVE_TYPES)assert.ok(FULL_GENUI_PROMPT.includes(name+': '),name+' is taught to the model')
assert.ok(!isRenderableProcess(processGenuiSpec({items:[{type:'script',content:'alert(1)'}]})))
assert.equal(compileMathExprProgram('window.location=1'),null)
console.log('PASS '+GENUI_NATIVE_TYPES.size+' catalog types, '+genuiTemplates().length+' templates, functional fixtures and unsafe-component guards')
