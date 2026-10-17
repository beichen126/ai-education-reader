import assert from 'node:assert/strict'
import { mapTocBatches, pipelineTocBatches } from '../src/documents/toc-work-queue.ts'
import { describeTocRepairReasons } from '../src/documents/toc-repair-reasons.ts'
import { prioritizeThumbnails } from '../src/documents/thumbnail-priority.ts'
import { countStreamedTocLevels, inferNumberedTocLevels, inferFallbackTocLevels, validateTocStructure, buildTocStructureRepairPrompt } from '../src/documents/ai-toc.ts'
import { resolveStoredModel, DEFAULT_MODEL } from '../src/api/model-defaults.ts'
import { isVisionModel, streamTextChat } from '../src/api/deepseek.ts'

let active = 0, peak = 0
const pending: Array<() => void> = []
const task = mapTocBatches([0, 1, 2], 2, async value => { active++; peak = Math.max(peak, active); await new Promise<void>(resolve => pending[value] = resolve); active--; return value })
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(peak, 2)
pending[1](); await new Promise(resolve => setTimeout(resolve, 0)); pending[2](); pending[0]()
assert.deepEqual(await task, [0, 1, 2], 'out-of-order requests retain PDF source order')
const prepared: number[] = [], releases: Array<() => void> = []
let allPrepared: () => void = () => {}
const preparationDone = new Promise<void>(resolve=>allPrepared=resolve)
let preparing = 0, preparationPeak = 0, requesting = 0, requestPeak = 0
const pipelined = pipelineTocBatches([0,1,2,3,4,5,6], 3, 5, async value => {
  preparing++; preparationPeak = Math.max(preparationPeak, preparing)
  await new Promise(resolve => setTimeout(resolve, 1))
  prepared.push(value); preparing--; if(prepared.length===7)allPrepared(); return value
}, async value => {
  requesting++; requestPeak = Math.max(requestPeak, requesting)
  await new Promise<void>(resolve => releases[value] = resolve)
  requesting--; return value
})
await preparationDone
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(preparationPeak, 3)
assert.equal(requestPeak, 5)
assert.equal(prepared.length, 7, 'all batches prepare even while five network requests are held')
releases[4](); releases[3]()
await new Promise(resolve => setTimeout(resolve, 0))
releases[6](); releases[5](); releases[2](); releases[1](); releases[0]()
assert.deepEqual(await pipelined, [0,1,2,3,4,5,6])
const pipelineAbort = new AbortController()
let requestsStarted = 0
const cancelled = pipelineTocBatches([0,1,2,3,4,5,6], 3, 5, async v => v, async (v, _, __, signal) => {
  requestsStarted++
  await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
  return v
}, pipelineAbort.signal)
await new Promise(resolve => setTimeout(resolve, 0)); pipelineAbort.abort()
await assert.rejects(cancelled, /Aborted/)
assert.equal(requestsStarted, 5, 'cancelled queued requests never start')
await assert.rejects(pipelineTocBatches([0,1,2], 3, 5, async v => { if (v === 0) throw new Error('prepare failed'); return v }, async v => v), /prepare failed/)
await assert.rejects(pipelineTocBatches([0,1,2], 3, 5, async v => v, async () => { throw new Error('request failed') }), /request failed/)
assert.match(describeTocRepairReasons([{code:'LEVEL_COUNT_MISMATCH', message:'private', actualLevels:240, expectedRows:942}], true), /240.*942/)
assert.match(describeTocRepairReasons([{code:'OUTPUT_TRUNCATED', message:'private'}], true), /truncated/)
assert.match(describeTocRepairReasons([{code:'SUSPICIOUS_FLAT', message:'private'}], false), /扁平化/)
const measure = (page:number) => ({top:page*100,bottom:page*100+80})
assert.deepEqual(prioritizeThumbnails([1,2,3,4,5,6,7,8,9],{top:300,bottom:700},measure),[5,4,6,3,7,2,8,1])
assert.deepEqual(prioritizeThumbnails([1,2,3,4,5,6,7,8,9],{top:700,bottom:900},measure),[8,7,9,6,5], 'scrolling reorders around the new viewport and drops stale queued pages')
const controller = new AbortController(), started: number[] = []
await assert.rejects(mapTocBatches([0, 1, 2, 3], 2, async (value, _, signal) => { started.push(value); if (value === 0) throw new Error('fatal'); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) }); return value }), /fatal/)
assert.deepEqual(started, [0, 1], 'fatal error aborts siblings without starting queued requests')
controller.abort()
await assert.rejects(mapTocBatches([1], 2, async () => 1, controller.signal), /Aborted/)

assert.equal(countStreamedTocLevels('{"levels":[1,2,3', 10), 2)
assert.equal(countStreamedTocLevels('{"levels":[1,2,30]}', 10), 3)
assert.equal(countStreamedTocLevels('thinking about 900 headings', 10), 0)
assert.equal(countStreamedTocLevels('{"levels":[1,2,3]}', 2), 2)
const titles = ['第一编 总论', '第一章 基础', '第一节 原理', '第二节 应用', '第二章 方法', '第二编 分论']
const rows = titles.map((title, i) => ({ title, id: 'r' + i, pageLabel: String(i + 1), sourceImageIndex: 1, tocPage: 1, rowOrder: i }))
assert.deepEqual(inferNumberedTocLevels(rows), [1, 2, 3, 3, 2, 1])
assert.deepEqual(inferFallbackTocLevels(rows), [1, 2, 3, 3, 2, 1])
const flattened = validateTocStructure(rows, rows.map(() => 1))
assert.equal(flattened.ok, false)
assert.ok(buildTocStructureRepairPrompt(rows.length, flattened.diagnostics).includes('flattened'))
assert.ok(validateTocStructure(rows, [1, 2, 3, 3, 2, 1]).ok)
assert.equal(inferNumberedTocLevels(['Chapter 1', 'Chapter 2', 'Chapter 3'].map(title => ({ title }))), null, 'genuinely flat chapters are not forced into L3')
assert.equal(DEFAULT_MODEL, 'deepseek-flash'); assert.equal(isVisionModel(DEFAULT_MODEL), true)
assert.equal(isVisionModel(DEFAULT_MODEL, 'text-only'), false)
assert.equal(resolveStoredModel('', ''), DEFAULT_MODEL)
assert.equal(resolveStoredModel('deepseek-v4-flash-vision-exp', 'https://api.deepseek.com/v1'), DEFAULT_MODEL)
assert.equal(resolveStoredModel('my-model', 'https://api.deepseek.com'), 'my-model')
assert.equal(resolveStoredModel('deepseek-v4-flash-vision-exp', 'https://custom.example'), 'deepseek-v4-flash-vision-exp')
const originalFetch = globalThis.fetch
let request: any, deltas = ''
try {
  globalThis.fetch = (async (_, init) => {
    request = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"{\\\"levels\\\":[1,2,3]}"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  await streamTextChat({ apiKey: 'test', baseUrl: 'https://api.deepseek.com', model: DEFAULT_MODEL, messages: [], thinking: 'enabled', reasoningEffort: 'high', onDelta: delta => deltas += delta })
  assert.equal(request.reasoning_effort, 'high'); assert.equal(request.thinking.type, 'enabled')
  assert.equal(deltas, '{"levels":[1,2,3]}')
  await streamTextChat({ apiKey: 'test', baseUrl: 'https://api.deepseek.com', model: DEFAULT_MODEL, messages: [], onDelta: () => {} })
  assert.equal(request.reasoning_effort, 'max'); assert.equal(request.thinking, undefined, 'chat reasoning remains max without task overrides')
} finally { globalThis.fetch = originalFetch }
console.log('PASS TOC pipeline: parallel ordering/cancellation, streamed progress, semantic L3 checks/fallback, Flash defaults and unchanged chat max')
