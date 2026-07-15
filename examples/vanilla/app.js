const SDK = window.ConvincedWidgetSDK

if (!SDK) throw new Error('Convinced Widget SDK browser build did not load.')

const logElement = document.querySelector('#event-log')
const log = (message) => {
  if (logElement.children.length === 1 && logElement.firstElementChild?.textContent?.includes('Waiting')) {
    logElement.replaceChildren()
  }
  const item = document.createElement('li')
  item.textContent = message
  logElement.prepend(item)
  while (logElement.children.length > 5) logElement.lastElementChild?.remove()
}

const tools = new SDK.ClientToolRegistry()
SDK.registerDomTools(tools, {
  capabilities: {
    scroll: true,
    highlight: true,
  },
  // Local demo only. Production hosts should show a consent UI or enforce an
  // application policy before allowing a model-requested page mutation.
  authorize: ({ action, target }) => {
    log(`DOM authorized: ${action}${target ? ` → ${target}` : ''}`)
    return true
  },
  highlightColor: '#d75a36',
})

const client = new SDK.ConvincedClient({
  orgSlug: 'demo',
  apiBase: window.location.origin,
  tools,
  // Local demo only. Production integrations should authorize from trusted
  // application state and use per-call confirmation for page mutations.
  authorizeToolCall: ({ tool }) => {
    log(`Protocol consent: ${tool.name}`)
    return true
  },
})

client.on('ready', () => log('Session ready; slide catalog loaded'))
client.on('client_tool_call', ({ call }) => log(`Runtime requested: ${call.name}`))
client.on('client_tool_result', (result) => log(`${result.ok ? 'Completed' : 'Failed'}: ${result.name}`))
client.on('identity', ({ input }) => log(`Identity captured: ${input.email}`))
client.on('error', (error) => log(`Error: ${error.message}`))

const widget = SDK.mountConvincedWidget({
  client,
  placement: 'floating',
  title: 'Fieldworks floor specialist',
  launcherLabel: 'Ask the Fieldworks floor specialist',
  theme: {
    primary: '#c24c2e',
    onPrimary: '#fffaf2',
    accent: '#fffaf2',
    background: '#f3eee4',
    surface: '#fffaf2',
    text: '#17231e',
    muted: '#68746d',
    border: '#cec5b5',
    radius: '6px',
    fontFamily: '"Avenir Next", "Segoe UI", sans-serif',
    width: '410px',
    height: '650px',
  },
  identityPolicy: ({ state, assistantMessages }) => {
    if (state.identity) return false
    if (state.status !== 'streaming' && assistantMessages < 1) return false
    return {
      title: 'Get the warehouse rollout brief',
      description: 'Share your work details and we’ll tailor the next steps.',
      submitLabel: 'Send my brief',
      fields: ['email', 'name', 'company'],
    }
  },
})

document.querySelector('#open-assistant').addEventListener('click', () => widget.open())

window.demo = { client, tools, widget }
