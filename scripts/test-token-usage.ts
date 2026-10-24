import assert from 'node:assert/strict'
import { parseTokenUsage } from '../src/engine/token-usage'
import { streamTextChat } from '../src/api/deepseek'
import { relayResponses } from '../server/openai-contract.mjs'

const expected = { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
assert.deepEqual(parseTokenUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }), expected)
for (const bad of [null, {}, { input_tokens: -1, output_tokens: 2, total_tokens: 1 }, { input_tokens: '120', output_tokens: 30, total_tokens: 150 }]) assert.equal(parseTokenUsage(bad), undefined)
const savedFetch = globalThis.fetch
try {
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
