import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleProxyRequest, withStreamIdleTimeout } from '../proxy/handler.js'
import { ProviderService } from '../services/providerService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-network-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  resetSettingsCache()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe('proxy network settings', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('uses configured AI request timeout for non-stream upstream requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 45_000,
          proxy: { mode: 'system', url: '' },
        },
      }),
      'utf-8',
    )

    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'OpenAI Proxy',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'openai_chat',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    const timeoutCalls: number[] = []
    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: 'chatcmpl-network-timeout',
        object: 'chat.completion',
        created: 0,
        model: 'model-main',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    AbortSignal.timeout = ((ms: number) => {
      timeoutCalls.push(ms)
      return originalTimeout(ms)
    }) as typeof AbortSignal.timeout

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))

      expect(res.status).toBe(200)
      expect(timeoutCalls).toEqual([45_000])
    } finally {
      AbortSignal.timeout = originalTimeout
      globalThis.fetch = originalFetch
    }
  })

  test('uses configured AI request timeout for non-stream Responses upstream requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 45_000,
          proxy: { mode: 'system', url: '' },
        },
      }),
      'utf-8',
    )

    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'OpenAI Responses Proxy',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'openai_responses',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    const timeoutCalls: number[] = []
    globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        id: 'resp-network-timeout',
        status: 'completed',
        model: 'model-main',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    AbortSignal.timeout = ((ms: number) => {
      timeoutCalls.push(ms)
      return originalTimeout(ms)
    }) as typeof AbortSignal.timeout

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))

      expect(res.status).toBe(200)
      expect(timeoutCalls).toEqual([45_000])
    } finally {
      AbortSignal.timeout = originalTimeout
      globalThis.fetch = originalFetch
    }
  })

  test('uses configured AI request timeout while opening and reading streaming upstream requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 180_000,
          proxy: { mode: 'system', url: '' },
        },
      }),
      'utf-8',
    )

    const svc = new ProviderService()
    const provider = await svc.addProvider({
      presetId: 'custom',
      name: 'OpenAI Proxy',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      apiFormat: 'openai_chat',
      models: {
        main: 'model-main',
        haiku: 'model-main',
        sonnet: 'model-main',
        opus: 'model-main',
      },
    })

    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const timeoutCalls: number[] = []
    const timers: Array<{ ms: number | undefined; cleared: boolean }> = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as typeof fetch
    AbortSignal.timeout = ((ms: number) => {
      timeoutCalls.push(ms)
      return originalTimeout(ms)
    }) as typeof AbortSignal.timeout
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      const timer = { ms, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
      const found = timers.find((entry) => entry === timer)
      if (found) found.cleared = true
    }) as typeof clearTimeout

    try {
      const body = {
        model: 'model-main',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${provider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))
      await res.text()

      expect(res.status).toBe(200)
      expect(timeoutCalls).toEqual([])
      expect(timers).toEqual([
        { ms: 180_000, cleared: true },
        { ms: 180_000, cleared: true },
        { ms: 180_000, cleared: true },
      ])
    } finally {
      globalThis.clearTimeout = originalClearTimeout
      globalThis.setTimeout = originalSetTimeout
      AbortSignal.timeout = originalTimeout
      globalThis.fetch = originalFetch
    }
  })

  test('routes image requests from a native text provider to its configured vision provider', async () => {
    const svc = new ProviderService()
    const visionProvider = await svc.addProvider({
      presetId: 'custom',
      name: 'MiMo Vision',
      baseUrl: 'https://vision.example.com',
      apiKey: 'sk-vision',
      apiFormat: 'openai_chat',
      models: {
        main: 'mimo-v2.5',
        haiku: 'mimo-v2.5',
        sonnet: 'mimo-v2.5',
        opus: 'mimo-v2.5',
      },
    })
    const textProvider = await svc.addProvider({
      presetId: 'custom',
      name: 'MiMo Text',
      baseUrl: 'https://text.example.com/anthropic',
      apiKey: 'sk-text',
      authStrategy: 'auth_token',
      apiFormat: 'anthropic',
      models: {
        main: 'mimo-v2.5-pro',
        haiku: 'mimo-v2.5-pro',
        sonnet: 'mimo-v2.5-pro',
        opus: 'mimo-v2.5-pro',
      },
      visionRouter: {
        providerId: visionProvider.id,
      },
    })
    await svc.activateProvider(textProvider.id)

    const originalFetch = globalThis.fetch
    let upstreamUrl = ''
    let upstreamBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      upstreamUrl = String(url)
      upstreamBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'chatcmpl-vision',
        object: 'chat.completion',
        created: 0,
        model: 'mimo-v2.5',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'vision ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const body = {
        model: 'mimo-v2.5-pro',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        }],
      }
      const req = new Request('http://localhost:3456/proxy/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const res = await handleProxyRequest(req, new URL(req.url))
      const json = await res.json() as Record<string, unknown>
      const messages = upstreamBody.messages as Array<{
        role: string
        content: string | Array<{ type: string; image_url?: { url: string } }>
      }>
      const userMessage = messages.find((message) => message.role === 'user')
      const userContent = userMessage?.content as Array<{ type: string; image_url?: { url: string } }>

      expect(res.status).toBe(200)
      expect(upstreamUrl).toBe('https://vision.example.com/v1/chat/completions')
      expect(upstreamBody.model).toBe('mimo-v2.5')
      expect(userContent[1].type).toBe('image_url')
      expect(userContent[1].image_url?.url).toBe('data:image/png;base64,abc123')
      expect(json.model).toBe('mimo-v2.5')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('routes image requests from a provider-scoped runtime path to its configured vision provider', async () => {
    const svc = new ProviderService()
    const visionProvider = await svc.addProvider({
      presetId: 'custom',
      name: 'MiMo Vision',
      baseUrl: 'https://vision.example.com',
      apiKey: 'sk-vision',
      apiFormat: 'openai_chat',
      models: {
        main: 'mimo-v2.5',
        haiku: 'mimo-v2.5',
        sonnet: 'mimo-v2.5',
        opus: 'mimo-v2.5',
      },
    })
    const textProvider = await svc.addProvider({
      presetId: 'custom',
      name: 'MiMo Text',
      baseUrl: 'https://text.example.com/anthropic',
      apiKey: 'sk-text',
      authStrategy: 'auth_token',
      apiFormat: 'anthropic',
      models: {
        main: 'mimo-v2.5-pro',
        haiku: 'mimo-v2.5-pro',
        sonnet: 'mimo-v2.5-pro',
        opus: 'mimo-v2.5-pro',
      },
      visionRouter: {
        providerId: visionProvider.id,
      },
    })

    const originalFetch = globalThis.fetch
    let upstreamUrl = ''
    let upstreamBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      upstreamUrl = String(url)
      upstreamBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'chatcmpl-provider-scoped-vision',
        object: 'chat.completion',
        created: 0,
        model: 'mimo-v2.5',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'vision ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const body = {
        model: 'mimo-v2.5-pro',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        }],
      }
      const req = new Request(
        `http://localhost:3456/proxy/providers/${textProvider.id}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      const json = await res.json() as Record<string, unknown>

      expect(res.status).toBe(200)
      expect(upstreamUrl).toBe('https://vision.example.com/v1/chat/completions')
      expect(upstreamBody.model).toBe('mimo-v2.5')
      expect(json.model).toBe('mimo-v2.5')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('passes text-only requests from a native provider through without using the vision provider', async () => {
    const svc = new ProviderService()
    const visionProvider = await svc.addProvider({
      presetId: 'custom',
      name: 'MiMo Vision',
      baseUrl: 'https://vision.example.com',
      apiKey: 'sk-vision',
      apiFormat: 'openai_chat',
      models: {
        main: 'mimo-v2.5',
        haiku: 'mimo-v2.5',
        sonnet: 'mimo-v2.5',
        opus: 'mimo-v2.5',
      },
    })
    const textProvider = await svc.addProvider({
      presetId: 'custom',
      name: 'MiMo Text',
      baseUrl: 'https://text.example.com/anthropic',
      apiKey: 'sk-text',
      authStrategy: 'auth_token',
      apiFormat: 'anthropic',
      models: {
        main: 'mimo-v2.5-pro',
        haiku: 'mimo-v2.5-pro',
        sonnet: 'mimo-v2.5-pro',
        opus: 'mimo-v2.5-pro',
      },
      visionRouter: {
        providerId: visionProvider.id,
      },
    })
    await svc.activateProvider(textProvider.id)

    const originalFetch = globalThis.fetch
    let upstreamUrl = ''
    let upstreamBody: Record<string, unknown> = {}
    let authorization = ''
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      upstreamUrl = String(url)
      upstreamBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const headers = init?.headers as Record<string, string>
      authorization = headers.Authorization ?? ''
      return new Response(JSON.stringify({
        id: 'msg-text',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'text ok' }],
        model: 'mimo-v2.5-pro',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const body = {
        model: 'mimo-v2.5-pro',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }
      const req = new Request('http://localhost:3456/proxy/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const res = await handleProxyRequest(req, new URL(req.url))
      const json = await res.json() as Record<string, unknown>

      expect(res.status).toBe(200)
      expect(upstreamUrl).toBe('https://text.example.com/anthropic/v1/messages')
      expect(upstreamBody.model).toBe('mimo-v2.5-pro')
      expect(authorization).toBe('Bearer sk-text')
      expect(json.model).toBe('mimo-v2.5-pro')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('fails a streaming upstream body that stops producing chunks', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"id\":\"chunk-1\",\"choices\":[]}\n\n'))
      },
    })

    await expect(new Response(withStreamIdleTimeout(stalled, 20)).text())
      .rejects
      .toThrow('Upstream stream idle timeout after 20ms')
  })

  test('propagates streaming upstream body errors before the idle timeout fires', async () => {
    let pulls = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('data: {\"id\":\"chunk-1\",\"choices\":[]}\n\n'))
          return
        }
        controller.error(new Error('upstream body failed'))
      },
    })
    const reader = withStreamIdleTimeout(upstream, 1_000).getReader()

    expect(await reader.read()).toEqual({
      done: false,
      value: new TextEncoder().encode('data: {\"id\":\"chunk-1\",\"choices\":[]}\n\n'),
    })
    await expect(reader.read()).rejects.toThrow('upstream body failed')
  })

  test('cancels the upstream body when the downstream stream is canceled', async () => {
    let cancelReason: unknown = null
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"id\":\"chunk-1\",\"choices\":[]}\n\n'))
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const reader = withStreamIdleTimeout(upstream, 1_000).getReader()

    expect((await reader.read()).done).toBe(false)
    await reader.cancel('downstream closed')

    expect(cancelReason).toBe('downstream closed')
  })
})
