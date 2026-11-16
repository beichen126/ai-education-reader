import assert from 'node:assert/strict'
import { parseTokenUsage, formatTokenCount } from '../src/engine/token-usage'
import { streamTextChat, streamUsageOptions } from '../src/api/deepseek'
import { relayResponses } from '../server/openai-contract.mjs'

const expected = { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
assert.equal(formatTokenCount(74650), '74.65k')
assert.equal(formatTokenCount(2114), '2.11k')
assert.equal(formatTokenCount(0), '0.00k')
assert.equal(formatTokenCount(999), '1.00k')
assert.equal(formatTokenCount(45), '0.05k')
assert.deepEqual(parseTokenUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }), expected)
for (const bad of [null, {}, { input_tokens: -1, output_tokens: 2, total_tokens: 1 }, { input_tokens: '120', output_tokens: 30, total_tokens: 150 }]) assert.equal(parseTokenUsage(bad), undefined)
const savedFetch = globalThis.fetch
assert.deepEqual(streamUsageOptions('https://api.teamorouter.com/v1'),{stream_options:{include_usage:true}})
assert.deepEqual(streamUsageOptions('https://teamorouter.com.evil.example/v1'),{})
assert.deepEqual(parseTokenUsage({input_tokens:1000,output_tokens:500,total_tokens:2500,cached_read_tokens:200,cached_write_tokens:800}),{inputTokens:1000,outputTokens:500,totalTokens:2500,cachedReadTokens:200,cachedWriteTokens:800})
assert.deepEqual(parseTokenUsage({...expected,prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:10}}),{...expected,cachedReadTokens:0,reasoningTokens:10})
try {
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).stream_options,{include_usage:true})
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'ok'}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150,prompt_tokens_details:{cached_tokens:80}}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})
  }
  const teamo=await streamTextChat({apiKey:'mock',baseUrl:'https://api.teamorouter.com/v1',model:'gemini-3.8-flash',messages:[{role:'user',content:'test'}],onDelta(){}})
  assert.deepEqual(teamo.usage,{...expected,cachedReadTokens:80})
  for (const usageOnly of [true, false]) {
    globalThis.fetch = async () => new Response([
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: usageOnly ? [] : [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    const r = await streamTextChat({ apiKey: 'mock', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', messages: [{ role: 'user', content: 'test' }], onDelta() {} })
    assert.deepEqual(r.usage, expected)
    assert.equal(r.content, 'hello')
  }
} finally { globalThis.fetch = savedFetch }
for (const usage of [{ input_tokens: 120, output_tokens: 30, total_tokens: 150, secret: 'must-not-relay' }, undefined, { input_tokens: -1, output_tokens: 30, total_tokens: 150 }]) {
  const events: any[] = []
  await relayResponses(new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`).body, (e: any) => events.push(e))
  assert.deepEqual(events[0].usage, usage?.input_tokens === 120 ? expected : undefined)
  assert.ok(!JSON.stringify(events).includes('must-not-relay'))
}
console.log('PASS: DS final-content/usage-only chunks, GPT completed usage, missing/invalid counters and metadata filtering')
