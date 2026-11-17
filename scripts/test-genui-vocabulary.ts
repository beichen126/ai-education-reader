import assert from 'node:assert/strict'
import {parseVocabulary} from '../src/genui/vocabulary-schema'
import {GENUI_PROMPT} from '../src/genui/schema'
const sample={schema:'reader-vocabulary',items:[{type:'vocabulary',word:'analytics',phonetic:'/ˌænəˈlɪtɪks/',meaning:'数据分析'}]}
assert.equal(parseVocabulary(JSON.stringify(sample)).items[0].word,'analytics')
assert.throws(()=>parseVocabulary(JSON.stringify({...sample,items:[{...sample.items[0],word:{html:'x'}}]})))
assert.equal(parseVocabulary(JSON.stringify({...sample,items:Array(100).fill(sample.items[0])})).items.length,100)
assert.throws(()=>parseVocabulary(JSON.stringify({...sample,items:[{...sample.items[0],type:'script'}]})))
assert.match(GENUI_PROMPT,/reader-vocabulary/)
console.log('PASS vocabulary schema bounds and real GenUI protocol inclusion')

const {diagramRanks}=await import('../src/genui/readable-diagram-layout')
const nodes=['a','b','c','d'].map(id=>({id,label:id}))
assert.deepEqual(diagramRanks({kind:'architecture',nodes,edges:[{from:'a',to:'b'},{from:'a',to:'c'},{from:'b',to:'d'},{from:'c',to:'d'}]})?.map(row=>row.map(n=>n.id)),[['a'],['b','c'],['d']])
assert.equal(diagramRanks({kind:'architecture',nodes,edges:[{from:'a',to:'b'},{from:'b',to:'a'}]}),null)
assert.equal(diagramRanks({kind:'sequence',nodes}),null)
console.log('PASS readable diagram branching/join order and native fallback for cycles and other layouts')
