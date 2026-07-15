/**
 * Deterministic stand-in for `Conversation.startSession`.
 *
 * The SDK receives this through its public `conversationFactory` seam. The
 * mock deliberately speaks the same small surface as the real ElevenLabs
 * conversation object so browser tests exercise the SDK voice adapter and
 * registered host tools without asking for microphone permission.
 */
export function createMockConversationFactory(options = {}) {
  let sequence = 0
  const destinations = {
    pricing: {
      url: '/pricing',
      selector: '#pricing-enterprise',
      color: '#ff5c35',
      reply: 'I opened pricing and highlighted the enterprise plan. It is the option with rollout design and a shared success plan.',
      ...(options.destinations?.pricing ?? {}),
    },
    proof: {
      url: '/case-study',
      selector: '#case-study-metric',
      color: '#2de2a6',
      reply: 'Here is the proof: Northstar reduced time to first value by forty two percent after changing the rollout around buyer intent.',
      ...(options.destinations?.proof ?? {}),
    },
    home: {
      url: '/home',
      selector: '#home-demo-map',
      reply: 'Back at the product overview. I have centered the live demo map so we can choose where to go next.',
      ...(options.destinations?.home ?? {}),
    },
  }

  return async (startOptions) => {
    const id = `mock-elevenlabs-${++sequence}`
    const clientTools = startOptions.clientTools ?? {}
    let ended = false
    let muted = false

    const trace = (kind, detail) => options.onTrace?.({ kind, detail, conversationId: id })
    const status = (value) => startOptions.onStatusChange?.({ status: value })
    const mode = (value) => startOptions.onModeChange?.({ mode: value })
    const message = (source, text) => startOptions.onMessage?.({
      source,
      role: source === 'user' ? 'user' : 'agent',
      message: text,
    })

    const invoke = async (name, args) => {
      const tool = clientTools[name]
      if (typeof tool !== 'function') {
        throw new Error(`Mock ElevenLabs agent could not find client tool "${name}".`)
      }
      trace('tool_request', { name, args })
      const result = await tool(args)
      trace('tool_result', { name, result })
      return result
    }

    const answer = async (text) => {
      if (ended) return
      message('user', text)
      mode('speaking')
      const normalized = text.toLowerCase()

      if (normalized.includes('pricing')) {
        await invoke('host_navigate', { url: destinations.pricing.url })
        await invoke('host_get_page_context', {})
        await invoke('host_scroll_to', {
          selector: destinations.pricing.selector,
          behavior: 'smooth',
          block: 'center',
        })
        await invoke('host_highlight', {
          selector: destinations.pricing.selector,
          durationMs: 1800,
          color: destinations.pricing.color,
        })
        message('ai', destinations.pricing.reply)
      } else if (normalized.includes('case') || normalized.includes('proof')) {
        await invoke('host_navigate', { url: destinations.proof.url })
        await invoke('host_get_page_context', {})
        await invoke('host_scroll_to', {
          selector: destinations.proof.selector,
          behavior: 'smooth',
          block: 'center',
        })
        await invoke('host_highlight', {
          selector: destinations.proof.selector,
          durationMs: 1800,
          color: destinations.proof.color,
        })
        message('ai', destinations.proof.reply)
      } else if (normalized.includes('home') || normalized.includes('start')) {
        await invoke('host_navigate', { url: destinations.home.url })
        await invoke('host_scroll_to', {
          selector: destinations.home.selector,
          behavior: 'smooth',
          block: 'center',
        })
        message('ai', destinations.home.reply)
      } else if (normalized.includes('inventory') || normalized.includes('mcp')) {
        const result = await invoke('host_extension_call', {
          name: 'client_mcp_inventory_lookup',
          arguments_json: JSON.stringify({ sku: 'enterprise' }),
        })
        message('ai', `I checked the customer-provided MCP tool. ${result}`)
      } else {
        message('ai', 'Try asking me to open pricing or show the customer proof. In mock mode I will use the same registered browser tools as the live voice agent.')
      }

      mode('listening')
    }

    queueMicrotask(() => {
      status('connected')
      mode('listening')
      startOptions.onConnect?.({ conversationId: id })
      message('ai', options.firstMessage ?? 'Voice is ready. Ask me to open pricing or show customer proof.')
      trace('connected', { transport: 'deterministic-mock' })
    })

    return {
      async endSession() {
        if (ended) return
        ended = true
        status('disconnected')
        startOptions.onDisconnect?.({ reason: 'mock_session_ended' })
        trace('disconnected', {})
      },
      getId() {
        return id
      },
      setMicMuted(value) {
        muted = Boolean(value)
        trace('microphone', { muted })
      },
      sendContextualUpdate(text) {
        trace('contextual_update', { text })
      },
      sendUserMessage(text) {
        trace('user_message', { text })
        void answer(String(text)).catch((error) => startOptions.onError?.(
          error instanceof Error ? error.message : String(error),
          { source: 'deterministic-mock' },
        ))
      },
      sendUserActivity() {
        trace('user_activity', {})
      },
    }
  }
}
