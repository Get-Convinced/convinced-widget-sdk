import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const sdkBundle = fileURLToPath(new URL('../dist/convinced-widget.global.js', import.meta.url))
const output = fileURLToPath(new URL('../artifacts/webmcp/', import.meta.url))
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), native: true, cases: [], limitations: [
  'Scripted tool-selection tests, not an autonomous-model success-rate benchmark.',
  'Voice SDK callbacks run against a fake transport; no paid ElevenLabs session or speech latency is measured.',
] }
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end(`<!doctype html><html><head><title>Independent WebMCP shop</title></head><body>
  <h1>Independent WebMCP shop</h1><p id="basket">Basket: 0</p>
  <script>
  window.count = 0;
  window.ready = Promise.all([
    document.modelContext.registerTool({name:'shop_stock', description:'Read notebook stock', inputSchema:{type:'object',properties:{}},
      annotations:{readOnlyHint:true}, execute:()=>({item:'notebook',stock:8})}),
    document.modelContext.registerTool({name:'shop_add', description:'Add notebooks to the basket',
      inputSchema:{type:'object',properties:{quantity:{type:'integer',minimum:1,maximum:8}},required:['quantity'],additionalProperties:false},
      execute:({quantity})=>{if(!Number.isInteger(quantity)||quantity<1||quantity>8)throw new Error('Invalid quantity');
        window.count+=quantity;document.querySelector('#basket').textContent='Basket: '+window.count;return {count:window.count,confirmed:true}}})
  ]);
  </script></body></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const shopUrl = `http://127.0.0.1:${server.address().port}`
const browser = await puppeteer.launch({
  executablePath: process.env.WEBMCP_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--enable-features=WebMCP', '--enable-blink-features=WebMCP'],
})
report.browser = await browser.version()

async function connect(page, url, expectedCount) {
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 })
  await page.waitForFunction(async count => document.modelContext && (await document.modelContext.getTools()).length === count, { timeout: 30_000 }, expectedCount)
  await page.addScriptTag({ path: sdkBundle })
  return page.evaluate(async () => {
    const S = window.ConvincedWidgetSDK
    window.bridge = S.createWebMcpBridge({ modelContext: document.modelContext, origin: location.origin,
      authorize: tool => tool.origin === location.origin && !tool.annotations?.consequentialHint })
    let callbacks
    window.voice = new S.ConvincedVoiceController({
      orgSlug: 'webmcp-test', sessionId: null,
      tools: new S.ClientToolRegistry(window.bridge.tools),
      descriptor: { agentId: 'agent_local_webmcp_test', exactClientTools: S.WEBMCP_VOICE_BINDINGS, genericClientTool: false },
      conversationFactory: async options => {
        callbacks = options.clientTools
        options.onConnect?.({ conversationId: 'conv_native_webmcp_test' })
        return { endSession: async () => {}, getId: () => 'conv_native_webmcp_test', setMicMuted: () => {}, sendContextualUpdate: () => {}, sendUserMessage: () => {} }
      },
    })
    await window.voice.start()
    window.agentCallbacks = callbacks
    window.invokeWebMcp = async (name, args) => {
      const start = performance.now()
      const schemaResponse = JSON.parse(await callbacks.webmcp_list_tools({ names: [name] }))
      const definition = schemaResponse.observation.result.tools[0]
      if (!definition) throw new Error('Tool not discovered: ' + name)
      const response = JSON.parse(await callbacks.webmcp_execute_tool({ tool_id: definition.id, arguments_json: JSON.stringify(args) }))
      return { elapsedMs: performance.now() - start, response, result: response.observation.result }
    }
    const catalog = await window.bridge.listTools()
    const all = await document.modelContext.getTools()
    return { count: catalog.total_count, names: all.map(t => t.name),
      voiceCallbacks: Object.keys(callbacks), catalogBytes: new TextEncoder().encode(JSON.stringify(catalog)).length,
      fixedSchemaBytes: new TextEncoder().encode(JSON.stringify(window.bridge.tools.map(({handler,...definition})=>definition))).length }
  })
}

async function check(page, label, name, args, verify) {
  let outcome
  try {
    outcome = await page.evaluate((name, args) => window.invokeWebMcp(name, args), name, args)
    verify(outcome)
    report.cases.push({ label, name, passed: true, ...outcome })
    console.log('PASS', label, Math.round(outcome.elapsedMs) + 'ms')
    return outcome.result
  } catch (error) {
    report.cases.push({ label, name, passed: false, error: String(error), ...outcome })
    console.log('FAIL', label, String(error))
  }
}
const ok = outcome => assert.equal(outcome.response.observation.ok, true)
const confirmed = outcome => { ok(outcome); assert.equal(outcome.result.presentation_confirmed, true); assert.equal(outcome.result.target_visible, true) }

try {
  const shop = await browser.newPage()
  report.shop = await connect(shop, shopUrl, 2)
  assert.deepEqual(report.shop.voiceCallbacks.sort(), ['webmcp_execute_tool', 'webmcp_list_tools'])
  await check(shop, 'Independent site: discover/read stock', 'shop_stock', {}, outcome => { ok(outcome); assert.equal(outcome.result.stock, 8) })
  await check(shop, 'Independent site: change visible basket', 'shop_add', { quantity: 2 }, outcome => { ok(outcome); assert.equal(outcome.result.count, 2) })
  assert.equal(await shop.$eval('#basket', element => element.textContent), 'Basket: 2')
  await check(shop, 'Independent site: invalid argument rejected', 'shop_add', { quantity: -1 }, outcome => assert.equal(outcome.response.observation.ok, false))
  assert.equal(await shop.$eval('#basket', element => element.textContent), 'Basket: 2')
  await shop.screenshot({ path: `${output}independent-site.png` })
  const stale = await shop.evaluate(async () => {
    const { tools } = await window.bridge.listTools(['shop_stock'])
    const controller = new AbortController()
    await document.modelContext.registerTool({ name: 'temporary', description: 'Temporary tool', inputSchema: { type: 'object', properties: {} }, execute: () => 'temporary' }, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 50))
    try { await window.bridge.executeTool(tools[0].id, {}); return false } catch { return true } finally { controller.abort() }
  })
  report.cases.push({ label: 'Native toolchange invalidates handles', passed: stale })

  if (process.env.WEBMCP_PUBLIC_DEMO === '1') {
    const pizza = await browser.newPage()
    report.publicDemo = await connect(pizza, 'https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/', 7)
    await check(pizza, 'Google demo: set pizza size', 'set_pizza_size', { size: 'Large' }, ok)
    await check(pizza, 'Google demo: change pizza style', 'set_pizza_style', { style: 'Pesto' }, ok)
    await check(pizza, 'Google demo: add mushrooms', 'add_topping', { topping: '🍄', count: 3 }, ok)
    // The demo animates topping entry after resolving its tool result.
    await new Promise(resolve => setTimeout(resolve, 800))
    report.publicDemo.visibleState = await pizza.evaluate(() => ({
      title: document.title,
      selects: [...document.querySelectorAll('select')].map(el => ({ id: el.id, value: el.value })),
      mushrooms: [...document.querySelectorAll('*')].filter(el => {
        const rect = el.getBoundingClientRect()
        return el.children.length === 0 && el.textContent === '🍄' && rect.width > 0 && rect.height > 0 && Number(getComputedStyle(el).opacity) > 0
      }).length,
      text: document.body.innerText,
    }))
    report.cases.push({ label: 'Google demo: three mushrooms visible in the DOM', passed: report.publicDemo.visibleState.mushrooms === 3 })
    await pizza.screenshot({ path: `${output}google-pizza-demo.png` })
  }

  if (process.env.WEBMCP_TEST_URL) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    report.enmovil = await connect(page, process.env.WEBMCP_TEST_URL, 16)
    report.enmovil.pageErrors = errors
    await check(page, 'Read current page state', 'host_get_experience_state', {}, ok)
    await check(page, 'Inspect supplier roles', 'host_inspect_workforce_scope', { scope_id: 'SUPPLIER' }, outcome => { ok(outcome); assert.ok(outcome.result.role_count > 0) })
    await check(page, 'Focus supplier stage', 'host_focus_workforce_scope', { scope_id: 'SUPPLIER' }, outcome => { ok(outcome); assert.equal(outcome.result.target_visible, true) })
    const search = await check(page, 'Search leadership', 'host_search_experience', { query: 'leadership', limit: 3 }, ok)
    report.enmovil.search = search
    await check(page, 'Open leadership with one page transaction', 'host_perform_transformation_page_action', { request: 'Show leadership', operation: 'open' }, confirmed)
    await page.screenshot({ path: `${output}enmovil-leadership.png` })
    await check(page, 'Resolve and present orchestration', 'host_resolve_and_present_experience', { query: 'Show orchestration' }, confirmed)
    await check(page, 'Open AI capacity planner role', 'host_present_workforce_role', { role_id: 'ai_capacity_planner' }, outcome => {
      ok(outcome); assert.equal(outcome.result.target_visible, true); assert.equal(outcome.result.brief_open, true)
    })
    const screen = await check(page, 'Describe role and available controls', 'host_describe_current_experience', {}, ok)
    const controls = screen?.available_controls ?? []
    const solution = controls.find(control => /solution/i.test(control.label ?? control.id ?? ''))
    if (solution) await check(page, 'Activate discovered solution control', 'host_activate_current_experience_control', { control_id: solution.id }, confirmed)
    else report.cases.push({ label: 'Activate discovered solution control', passed: false, error: 'No solution control in current screen' })
    await check(page, 'Control capacity demo baseline', 'host_control_experience_demo', { sku: 'RCCP', command: 'preset', preset: 'baseline' }, outcome => {
      ok(outcome); assert.equal(outcome.result.status, 'controlled'); assert.equal(outcome.result.action_performed, true); assert.equal(outcome.result.target_visible, true)
    })
    await page.screenshot({ path: `${output}enmovil-solution.png` })
    await check(page, 'Close current layer', 'host_close_experience_layer', {}, outcome => { ok(outcome); assert.equal(outcome.result.target_visible, true) })
    const first = search?.candidates?.[0]
    if (first) await check(page, 'Present a discovered canonical node', 'host_present_experience', { node_id: first.id ?? first.node_id }, confirmed)
    else report.cases.push({ label: 'Present a discovered canonical node', passed: false, error: 'Search result shape not recognized' })
    await check(page, 'Capture supplied visitor context', 'host_capture_visitor_context', { problem_id: 'planning', scope_id: 'SUPPLIER', industry_id: 'AUTO' }, ok)
    await check(page, 'Update guidance choices', 'host_set_guidance_options', {
      stage: 'clarify', eyebrow: 'Planning', prompt: 'Which assumption would you like to test?', explanation: 'Choose a planning assumption to explore.',
      options: [{ id: 'demand', label: 'Demand variability', user_message: 'Explore demand variability', action: 'ask' },
        { id: 'capacity', label: 'Capacity limits', user_message: 'Explore capacity limits', action: 'ask' }],
    }, ok)
    await check(page, 'Reject broader knowledge without its signed page-gap receipt', 'host_query_transformation_knowledge_fallback', {
      query: 'An unsupported detail', page_gap_reason: 'not-found', current_node_id: '', max_results: 1,
    }, outcome => { ok(outcome); assert.notEqual(outcome.result.status, 'success'); assert.equal(outcome.result.navigation_allowed, false) })
    await check(page, 'Prepare handoff without filling or submitting', 'host_prepare_demo_handoff', {}, confirmed)
    await check(page, 'Reject invalid page operation', 'host_perform_transformation_page_action', { request: 'Submit form', operation: 'submit' }, outcome => assert.equal(outcome.response.observation.ok, false))
    await check(page, 'Reject stale visible control', 'host_activate_current_experience_control', { control_id: 'nonexistent_control' }, outcome => { ok(outcome); assert.notEqual(outcome.result.presentation_confirmed, true) })
    await check(page, 'Primary page action opens orchestration', 'host_perform_transformation_page_action', { request: 'Show orchestration', operation: 'open' }, confirmed)
    await check(page, 'Primary page action opens the AI capacity planner', 'host_perform_transformation_page_action', { request: 'Show AI capacity planner', operation: 'open' }, confirmed)

    report.enmovil.timing = await page.evaluate(async () => {
      const tool = (await document.modelContext.getTools()).find(tool => tool.name === 'host_get_experience_state')
      const { tools } = await window.bridge.listTools(['host_get_experience_state'])
      const direct = [], generic = []
      for (let i = 0; i < 30; i++) {
        let t = performance.now(); await document.modelContext.executeTool(tool, '{}'); direct.push(performance.now()-t)
        t = performance.now(); await window.agentCallbacks.webmcp_execute_tool({ tool_id: tools[0].id, arguments_json: '{}' }); generic.push(performance.now()-t)
      }
      return { samples: 30, directNativeMs: direct, sdkVoiceBridgeMs: generic }
    })
    await page.goto(new URL('/privacy-policy', process.env.WEBMCP_TEST_URL).href, { waitUntil: 'domcontentloaded' })
    const remaining = await page.evaluate(async () => (await document.modelContext.getTools()).filter(tool => tool.name.startsWith('host_')).length)
    report.cases.push({ label: 'Tools disappear after leaving Transformation', passed: remaining === 0, remaining })

    // Reproduce the two legacy failures without the SDK bridge, in the same
    // initial page state. Keep failures visible; do not relabel them as success.
    await page.goto(process.env.WEBMCP_TEST_URL, { waitUntil: 'networkidle2' })
    await page.waitForFunction(async () => (await document.modelContext.getTools()).length === 16)
    report.enmovil.directNativeBaseline = await page.evaluate(async () => {
      const invoke = async (name, input) => {
        const tool = (await document.modelContext.getTools()).find(t => t.name === name)
        return JSON.parse(await document.modelContext.executeTool(tool, JSON.stringify(input)))
      }
      await invoke('host_focus_workforce_scope', { scope_id: 'SUPPLIER' })
      await invoke('host_perform_transformation_page_action', { request: 'Show leadership', operation: 'open' })
      return {
        orchestration: await invoke('host_resolve_and_present_experience', { query: 'Show orchestration' }),
        role: await invoke('host_present_workforce_role', { role_id: 'ai_capacity_planner' }),
      }
    })
  }
} catch (error) {
  report.cases.push({ label: 'Harness completed', passed: false, error: String(error) })
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  report.passed = report.cases.filter(item => item.passed).length
  report.failed = report.cases.filter(item => !item.passed).length
  await writeFile(`${output}native-results.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, report: `${output}native-results.json` }))
  if (report.failed) process.exitCode = 1
}
