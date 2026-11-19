import assert from 'node:assert/strict'
import { parseTokenUsage, formatTokenCount } from '../src/engine/token-usage'
import { apiRequestDiagnostic, DeepSeekError, sendTextChat, streamTextChat, streamUsageOptions } from '../src/api/deepseek'

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
  const endpoint = 'https://api.teamorouter.com/v1/chat/completions'
  const gemini = {
    apiKey: 'mock', baseUrl: 'https://teamorouter.com/', model: 'gemini-3.8-flash',
    messages: [
      { role: 'system' as const, content: 'system rules' },
      { role: 'user' as const, content: 'first turn' },
      { role: 'assistant' as const, content: 'old answer' },
      { role: 'assistant' as const, content: '' },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'test' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA==' } }] },
    ],
  }
  const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 20 } }
  const sse = (...frames: unknown[]) => new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  let answer = '', diagnostics = ''
  globalThis.fetch = async (url, init) => {
    assert.equal(url, endpoint)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, gemini.model)
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })
    assert.deepEqual(body.messages, gemini.messages.filter(message => message.content))
    assert.equal(body.generationConfig, undefined)
    assert.equal(body.contents, undefined)
    return sse({ choices: [{ delta: { reasoning_content: 'summary' } }] },
      { choices: [{ delta: { reasoning_content: ' continued', content: 'hello' }, finish_reason: 'stop' }] },
      { choices: [], usage })
  }
  const result = await streamTextChat({ ...gemini, onDelta: delta => { answer += delta }, onReasoningDelta: delta => { diagnostics += delta } })
  assert.equal(answer, 'hello')
  assert.equal(result.content, answer)
  assert.equal(diagnostics, 'summary continued')
  assert.equal(result.reasoning, diagnostics)
  assert.equal(result.finishReason, 'stop')
  assert.deepEqual(result.usage, { ...expected, cachedReadTokens: 80, reasoningTokens: 20 })

  for (const emptyContinuation of [false, true]) {
    let requests = 0, searches = 0
    const call = { id: 'search-1', type: 'function', function: { name: 'search_web', arguments: '{"query":"Python release date"}' } }
    globalThis.fetch = async (url, init) => {
      assert.equal(url, endpoint)
      const body = JSON.parse(String(init?.body))
      if (++requests === 1) {
        assert.equal(body.tool_choice, 'auto')
        assert.equal(body.tools[0].function.name, 'search_web')
        return sse({ choices: [{ delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }], usage })
      }
      if (requests === 2) {
        assert.equal(body.tool_choice, 'none')
        assert.deepEqual(body.messages.at(-2).tool_calls, [call])
        assert.equal(body.messages.at(-1).tool_call_id, call.id)
        assert.match(body.messages.at(-1).content, /official date/)
        if (emptyContinuation) return sse({ choices: [], usage })
      } else {
        assert.equal(body.tools, undefined)
        assert.match(body.messages.at(-1).content, /official date/)
      }
      return sse({ choices: [{ delta: { content: 'October 7, 2024.' }, finish_reason: 'stop' }], usage })
    }
    const searched = await streamTextChat({ ...gemini, baseUrl: 'https://api.teamorouter.com/v1', onDelta() {}, onWebToolCalls: async calls => {
      searches++
      assert.deepEqual(calls, { format: 'openai', calls: [call] })
      return [{ status: 'ok', sources: ['official date'] }]
    } })
    assert.equal(searched.content, 'October 7, 2024.')
    assert.equal(searches, 1)
    assert.equal(requests, emptyContinuation ? 3 : 2)
  }
  let emptyRequests = 0
  globalThis.fetch = async () => { emptyRequests++; return sse({ choices: [], usage }) }
  await assert.rejects(streamTextChat({ ...gemini, onDelta() {} }), error =>
    error instanceof DeepSeekError && error.kind === 'no-content' && apiRequestDiagnostic(error).includes('Gemini'))
  assert.equal(emptyRequests, 1)

  globalThis.fetch = async (url, init) => {
    assert.equal(url, endpoint)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.stream, false)
    assert.equal(body.stream_options, undefined)
    assert.equal(body.max_tokens, 8192)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    return Response.json({ choices: [{ message: { content: '{"answer":true}' }, finish_reason: 'stop' }] })
  }
  assert.deepEqual(await sendTextChat({ ...gemini, thinking: 'disabled', jsonObject: true, maxTokens: 8192 }), { content: '{"answer":true}', finishReason: 'stop' })
} finally { globalThis.fetch = savedFetch }
console.log('PASS: DeepSeek and Teamo Gemini OpenAI-compatible text, image, search, and token usage')
