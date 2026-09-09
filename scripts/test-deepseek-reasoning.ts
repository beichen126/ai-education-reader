import { deepSeekRequestOptions, DEFAULT_DEEPSEEK_REASONING_EFFORT, sendTextChat } from '../src/api/deepseek.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

assert(DEFAULT_DEEPSEEK_REASONING_EFFORT === 'max', 'DeepSeek default reasoning effort is max')
assert(deepSeekRequestOptions('', 'deepseek-v4-pro').reasoning_effort === 'max', 'DeepSeek model gets max even through a custom-compatible endpoint')
assert(deepSeekRequestOptions('https://api.deepseek.com', 'custom-model').reasoning_effort === 'max', 'DeepSeek endpoint gets max for its configured model')
assert(Object.keys(deepSeekRequestOptions('https://api.openai.com/v1', 'gpt-5')).length === 0, 'non-DeepSeek endpoint does not receive provider-specific reasoning fields')

const originalFetch = globalThis.fetch
let body: Record<string, unknown> | undefined
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  body = JSON.parse(String(init?.body)) as Record<string, unknown>
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
}) as typeof fetch
await sendTextChat({ apiKey: 'test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', messages: [] })
globalThis.fetch = originalFetch
assert(body?.reasoning_effort === 'max', 'sendTextChat sends max reasoning effort to DeepSeek')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
