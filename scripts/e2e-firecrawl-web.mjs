import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'

const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  const searches = [], reads = [], chats = []
  const pricing = 'https://example.com/pricing'
  let releaseSearch
  const heldSearch = new Promise(resolve => { releaseSearch = resolve })
  await page.route('https://api.firecrawl.dev/v2/search', async route => {
    const request = route.request()
    const body = request.postDataJSON()
    const key = request.headers().authorization
    searches.push({ body, key })
    if (key === 'Bearer fc-empty') return route.fulfill({ status: 402, json: { success: false } })
    if (body.query.includes('故障测试')) return route.fulfill({ status: 503, json: { success: false } })
    if (body.query.includes('取消测试')) {
      await heldSearch
      await route.abort().catch(() => {})
      return
    }
    return route.fulfill({ json: { success: true, creditsUsed: 2, data: { web: [
      { url: pricing, title: 'Firecrawl Pricing', description: 'Review the available Firecrawl plans.' },
      { url: 'https://example.com/faq', title: 'Plans FAQ', description: 'Answers about credit limits.' },
      { url: 'javascript:alert(1)', title: 'Bad source' },
    ] } } })
  })
  await page.route('https://api.firecrawl.dev/v2/scrape', route => {
    const body = route.request().postDataJSON()
    reads.push(body)
    if (body.url !== pricing) return route.fulfill({ status: 404, json: { success: false } })
    return route.fulfill({ json: { success: true, data: {
      markdown: 'Irrelevant navigation and content.\n\n'.repeat(600) + 'Firecrawl pricing and free credits. The free plan includes 1,000 credits per month.',
      metadata: { statusCode: 200, creditsUsed: 1 },
    } } })
  })
  let answers = 0
  await page.route('**/chat/completions', route => {
    const body = route.request().postDataJSON()
    chats.push(body)
    const question = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
    const query = ['故障测试', '取消测试'].find(text => question.includes(text))
      ?? (question.includes('那它的免费版呢？') ? 'Firecrawl free plan monthly pricing credits' : '')
    const calls = body.tool_choice === 'auto' && query
    const usage = { input_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    const chunks = calls ? [
      { choices: [{ delta: { reasoning_content: '需要查官方来源。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'search-1', type: 'function', function: { name: 'search_web', arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(query) + '}' } }] }, finish_reason: 'tool_calls' }], usage },
    ] : [{ choices: [{ delta: { content: '回答完成 ' + ++answers }, finish_reason: 'stop' }], usage }]
    return route.fulfill({ contentType: 'text/event-stream', body: chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n' })
  })

  await seedAndBoot(page, {
    convs: [{ id: 'web', title: '网页搜索测试', createdAt: 1, updatedAt: 1, messages: [
      msg('question', 'user', 'Firecrawl 怎么计费？'),
      msg('answer', 'assistant', '它区分不同的套餐。'),
    ] }],
    settings: {
      lastConversationId: 'web', apiKey: 'chat-test', apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
      webSearchEnabled: 'true', firecrawlKeys: [{ name: 'Key 1', key: 'fc-empty' }, { name: 'Key 2', key: 'fc-available' }],
    },
  })
  const toggle = page.getByRole('checkbox', { name: '联网搜索', exact: true })
  const attach = page.getByTestId('composer-attach')
  await attach.click()
  assert.equal(await toggle.isChecked(), true, 'an existing Firecrawl configuration enables search by default')
  await attach.click()

  const send = async (text, count) => {
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(text)
    await page.getByTestId('composer-send-stop').click()
    await page.getByText('回答完成 ' + count, { exact: true }).waitFor()
  }
  await send('请把上一段说短一点', 1)
  assert.equal(chats.length, 1)
  assert.equal(chats[0].tool_choice, 'auto')
  assert.equal(chats[0].tools[0].function.name, 'search_web')
  assert.equal(searches.length, 0, 'permission does not trigger a Firecrawl request')
  assert.equal(await page.getByText(/Firecrawl · 搜索/).count(), 0)

  await send('那它的免费版呢？', 2)
  assert.equal(searches.length, 4, 'three quota responses before rotation')
  assert.deepEqual(searches.map(({ key }) => key), ['Bearer fc-empty', 'Bearer fc-empty', 'Bearer fc-empty', 'Bearer fc-available'])
  assert.equal(searches[0].body.query, 'Firecrawl free plan monthly pricing credits')
  assert.deepEqual(searches[0].body.sources, ['web'])
  assert.equal(searches[0].body.limit, 5)
  assert.deepEqual(reads.map(read => read.url), [pricing, 'https://example.com/faq'])
  assert.deepEqual(reads[0].parsers, [])
  assert.equal(chats.length, 3)
  assert.equal(chats[2].tool_choice, 'none')
  assert.equal(chats[2].messages.at(-2).reasoning_content, '需要查官方来源。')
  assert.equal(chats[2].messages.at(-1).role, 'tool')
  assert.equal(chats[2].messages.at(-1).tool_call_id, 'search-1')
  assert.match(chats[2].messages.at(-1).content, /1,000 credits per month/)
  assert.ok(!JSON.stringify(chats[2]).includes('fc-available'))
  assert.ok(!JSON.stringify(chats[1].tools ?? []).includes('deepseek_web_search'))
  await page.getByText('Firecrawl · 搜索 4 次 · 读取 2 次 · ≥3 credits', { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Firecrawl Pricing', exact: true }).waitFor()
  assert.equal(await page.getByText('Bad source').count(), 0)

  await send('故障测试', 3)
  await page.getByText('网页搜索未完成，本轮基于已有上下文回答。', { exact: true }).waitFor()
  assert.equal(searches.length, 5)
  assert.equal(chats.length, 5)
  assert.equal(JSON.parse(chats[4].messages.at(-1).content).status, 'unavailable')
  assert.ok(!chats[3].messages.some(message => message.role === 'tool'), 'tool calls and results stay inside their turn')

  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('取消测试')
  const searchStarted = page.waitForRequest(request => request.url() === 'https://api.firecrawl.dev/v2/search' && request.postData()?.includes('取消测试'))
  const sendStop = page.getByTestId('composer-send-stop')
  await sendStop.click()
  await searchStarted
  await sendStop.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="composer-send-stop"]')?.getAttribute('aria-busy') === 'false')
  releaseSearch()
  assert.equal(chats.length, 6, 'stopping a search also stops the model continuation')

  await attach.click()
  await toggle.click()
  await page.waitForFunction(() => !document.querySelector('[aria-label="联网搜索已开启"]'))
  await page.reload({ waitUntil: 'networkidle' })
  await attach.click()
  assert.equal(await toggle.isChecked(), false)
  await attach.click()
  await send('直接解释这个概念', 4)
  assert.equal(searches.length, 6)
  assert.equal(chats.length, 7)
  assert.ok(!(chats[6].tools ?? []).some(tool => tool.type === 'deepseek_web_search' || tool.function?.name === 'search_web'))
  console.log('PASS model-triggered Firecrawl, direct reply with zero searches, split tool calls, quota rotation, errors and persistent opt-out')
} finally {
  await browser.close()
}
