import assert from 'node:assert/strict'
import { parseTokenUsage, formatTokenCount } from '../src/engine/token-usage'
import { sendTextChat, streamTextChat, streamUsageOptions } from '../src/api/deepseek'
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
  const teamo=await streamTextChat({apiKey:'mock',baseUrl:'https://api.teamorouter.com/v1',model:'other-model',messages:[{role:'user',content:'test'}],onDelta(){}})
  assert.deepEqual(teamo.usage,{...expected,cachedReadTokens:80})
  for (const usageOnly of [true, false]) {
    globalThis.fetch = async () => new Response([
      { choices: [{ delta: { reasoning_content: 'diagnostic text' } }] },
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: usageOnly ? [] : [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    const r = await streamTextChat({ apiKey: 'mock', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', messages: [{ role: 'user', content: 'test' }], onDelta() {} })
    assert.deepEqual(r.usage, expected)
    assert.equal(r.content, 'hello')
    assert.equal(r.reasoning, 'diagnostic text')
  }
  const gemini = {
    apiKey: 'mock', baseUrl: 'https://api.teamorouter.com/v1', model: 'gemini-3.8-flash',
    messages: [
      { role: 'system' as const, content: 'system rules' },
      { role: 'user' as const, content: 'first turn' },
      { role: 'assistant' as const, content: 'old answer' },
      { role: 'assistant' as const, content: '' },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'test' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA==' } }] },
    ],
  }
  let answer = '', diagnostics = ''
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.teamorouter.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse')
    const request = JSON.parse(String(init?.body))
    assert.deepEqual(request.generationConfig.thinkingConfig, { includeThoughts: true })
    assert.deepEqual(request.systemInstruction.parts, [{ text: 'system rules' }])
    assert.deepEqual(request.contents.map((entry: any) => entry.role), ['user', 'model', 'user'])
    assert.deepEqual(request.contents[2].parts[1], { inlineData: { mimeType: 'image/png', data: 'AA==' } })
    const frames = [
      { candidates: [{ content: { parts: [{ thought: true, text: 'summary' }] } }] },
      { candidates: [{ content: { parts: [{ thought: true, text: ' continued' }, { text: 'hello', thoughtSignature: 'opaque' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 170, cachedContentTokenCount: 80, thoughtsTokenCount: 20 } },
    ]
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame)).join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
  }
  const result = await streamTextChat({ ...gemini, onDelta: delta => { answer += delta }, onReasoningDelta: delta => { diagnostics += delta } })
  assert.equal(answer, 'hello')
  assert.equal(result.content, answer)
  assert.equal(diagnostics, 'summary continued')
  assert.equal(result.reasoning, diagnostics)
  assert.equal(result.finishReason, 'stop')
  assert.deepEqual(result.usage, { ...expected, totalTokens: 170, cachedReadTokens: 80, reasoningTokens: 20 })
  for (const signature of ['signed-call', undefined]) {
    let requests = 0
    const functionCall = { id: 'gemini-search-1', name: 'search_web', args: { query: 'Firecrawl pricing' } }
    const part = { functionCall, ...(signature ? { thoughtSignature: signature } : {}) }
    const usageMetadata = { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 170, cachedContentTokenCount: 80, thoughtsTokenCount: 20 }
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      if (++requests === 1) {
        assert.equal(request.toolConfig.functionCallingConfig.mode, 'AUTO')
        assert.equal(request.tools[0].functionDeclarations[0].name, 'search_web')
        return new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [part] } }], usageMetadata }), { headers: { 'content-type': 'text/event-stream' } })
      }
      if (signature) {
        assert.equal(request.toolConfig.functionCallingConfig.mode, 'NONE')
        assert.deepEqual(request.contents.at(-2).parts, [part])
        assert.deepEqual(request.contents.at(-1).parts, [{ functionResponse: { id: functionCall.id, name: functionCall.name, response: { status: 'ok', sources: ['official pricing'] } } }])
      } else {
        assert.equal(request.tools, undefined)
        assert.match(request.contents.at(-1).parts.at(-1).text, /untrusted.*\s+.*official pricing/)
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'The official pricing.' }] }, finishReason: 'STOP' }], usageMetadata })
    }
    const searched = await streamTextChat({ ...gemini, onDelta() {}, onWebToolCalls: async calls => {
      assert.deepEqual(calls, { format: 'gemini', parts: [part] })
      return [{ status: 'ok', sources: ['official pricing'] }]
    } })
    assert.equal(requests, 2)
    assert.equal(searched.content, 'The official pricing.')
    assert.deepEqual(searched.usage, { inputTokens: 240, outputTokens: 60, totalTokens: 340, cachedReadTokens: 160, reasoningTokens: 40 })
  }
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.teamorouter.com/v1beta/models/gemini-3.8-flash:generateContent')
    assert.deepEqual(JSON.parse(String(init?.body)).generationConfig, { thinkingConfig: { includeThoughts: false }, responseMimeType: 'application/json', maxOutputTokens: 8192 })
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"answer":true}' }] }, finishReason: 'STOP' }] })
  }
  assert.deepEqual(await sendTextChat({ ...gemini, thinking: 'disabled', jsonObject: true, maxTokens: 8192 }), { content: '{"answer":true}', finishReason: 'stop' })
} finally { globalThis.fetch = savedFetch }
for (const usage of [{ input_tokens: 120, output_tokens: 30, total_tokens: 150, secret: 'must-not-relay' }, undefined, { input_tokens: -1, output_tokens: 30, total_tokens: 150 }]) {
  const events: any[] = []
  await relayResponses(new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`).body, (e: any) => events.push(e))
  assert.deepEqual(events[0].usage, usage?.input_tokens === 120 ? expected : undefined)
  assert.ok(!JSON.stringify(events).includes('must-not-relay'))
}
console.log('PASS: DeepSeek and Teamo Gemini reasoning separation, native text/image/JSON requests, and token usage')
