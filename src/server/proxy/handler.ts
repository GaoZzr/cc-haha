/**
 * Proxy Handler — protocol-translating reverse proxy for OpenAI-compatible APIs.
 *
 * Receives Anthropic Messages API requests from the CLI, transforms them to
 * OpenAI Chat Completions or Responses API format, forwards to the upstream
 * provider, and transforms the response back to Anthropic format.
 *
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import { createHash } from 'node:crypto'
import { ProviderService } from '../services/providerService.js'
import { resolvePromptCacheKey } from './promptCacheKey.js'
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicContentBlock, AnthropicRequest } from './transform/types.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { getManualNetworkProxyUrl, loadNetworkSettings } from '../services/networkSettings.js'
import {
  formatRedteamConfirmationGate,
  prepareRedteamWorkflowPrompt,
  recordRedteamWorkflowCliMessage,
} from '../services/redteamWorkflowGuard.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  createTraceCallId,
  createTraceBodySnapshot,
  TRACE_STREAM_CAPTURE_BYTES,
  traceCaptureService,
  type TraceBodySnapshot,
  type TraceProviderInfo,
} from '../services/traceCaptureService.js'

const providerService = new ProviderService()

type ProxyProviderConfig = NonNullable<Awaited<ReturnType<ProviderService['getProviderForProxy']>>>
type ProxyFetchOptions = ReturnType<typeof getProxyFetchOptions>
type UpstreamRequestInit = RequestInit & ProxyFetchOptions
type ProxyTraceContext = {
  sessionId: string
  provider: TraceProviderInfo
  anthropicRequest: AnthropicRequest
}

const TRACE_RECORDED_ERROR_MARKER = Symbol('cc-haha-trace-recorded-error')

function markTraceErrorRecorded(error: unknown): void {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperty(error, TRACE_RECORDED_ERROR_MARKER, {
        value: true,
        enumerable: false,
      })
    } catch {
      // Best effort only; proxy error handling must not depend on trace metadata.
    }
  }
}

function wasTraceErrorRecorded(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as Record<symbol, unknown>)[TRACE_RECORDED_ERROR_MARKER])
}

function createTimeoutController(timeoutMs: number): {
  signal: AbortSignal
  clear: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  }
}

async function fetchUpstreamWithTimeout(
  url: string,
  init: Omit<UpstreamRequestInit, 'signal'>,
  timeoutMs: number,
  isStream: boolean,
): Promise<Response> {
  if (!isStream) {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  // For streaming requests, this timeout should only cover the connection and
  // response headers. Keeping the signal alive aborts long generations mid-body.
  const timeout = createTimeoutController(timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: timeout.signal,
    })
  } finally {
    timeout.clear()
  }
}

export function withStreamIdleTimeout(
  upstream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearIdleTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return new ReadableStream({
    async start(controller) {
      reader = upstream.getReader()
      let timedOut = false

      const armIdleTimer = () => {
        clearIdleTimer()
        timer = setTimeout(() => {
          timedOut = true
          void reader?.cancel('stream idle timeout').catch(() => undefined)
          controller.error(new Error(`Upstream stream idle timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      }

      try {
        armIdleTimer()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (timedOut) break

          controller.enqueue(value)
          armIdleTimer()
        }
        clearIdleTimer()
        if (!timedOut) controller.close()
      } catch (err) {
        clearIdleTimer()
        if (!timedOut) controller.error(err)
      }
    },
    cancel(reason) {
      clearIdleTimer()
      return reader?.cancel(reason)
    },
  })
}

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  const providerMatch = url.pathname.match(/^\/proxy\/providers\/([^/]+)\/v1\/messages$/)
  const providerId = providerMatch ? decodeURIComponent(providerMatch[1]!) : undefined
  const isActiveProxyPath = url.pathname === '/proxy/v1/messages'

  // Only handle POST /proxy/v1/messages or POST /proxy/providers/:providerId/v1/messages
  if (req.method !== 'POST' || (!isActiveProxyPath && !providerMatch)) {
    return Response.json(
      {
        error: 'Not Found',
        message: 'Proxy only handles POST /proxy/v1/messages and POST /proxy/providers/:providerId/v1/messages',
      },
      { status: 404 },
    )
  }

  // Read active/default provider config or an explicitly-scoped provider config.
  let config = await providerService.getProviderForProxy(providerId)
  if (!config) {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" is not configured for proxy`
            : 'No active provider configured for proxy',
        },
      },
      { status: 400 },
    )
  }

  if (config.apiFormat === 'anthropic' && !config.visionRouter) {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" uses anthropic format — proxy not needed`
            : 'Active provider uses anthropic format — proxy not needed',
        },
      },
      { status: 400 },
    )
  }

  // Parse request body
  let body: AnthropicRequest
  try {
    body = (await req.json()) as AnthropicRequest
  } catch {
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON in request body' } },
      { status: 400 },
    )
  }

  body = {
    ...body,
    model: normalizeModelStringForAPI(body.model),
  }

  const redteamGuard = applyRedteamWorkflowGuard(req, body)
  if (redteamGuard.response) {
    return redteamGuard.response
  }
  body = redteamGuard.body

  const routed = await maybeRouteToVisionProvider(config, body)
  if (routed.response) {
    return routed.response
  }
  config = routed.config
  body = routed.body

  const isStream = body.stream === true
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const networkSettings = await loadNetworkSettings()
  const proxyUrl = getManualNetworkProxyUrl(networkSettings)
  const traceContext = buildProxyTraceContext(req, config, body)
  const promptCacheKey = resolvePromptCacheKey(body, req.headers.get('x-claude-code-session-id'))

  try {
    if (config.apiFormat === 'anthropic') {
      return await handleAnthropic(body, baseUrl, config.apiKey, config.authStrategy, isStream, networkSettings.aiRequestTimeoutMs, proxyUrl)
    } else if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream, networkSettings.aiRequestTimeoutMs, proxyUrl, traceContext)
    } else {
      return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream, networkSettings.aiRequestTimeoutMs, proxyUrl, traceContext, promptCacheKey)
    }
  } catch (err) {
    if (traceContext && !wasTraceErrorRecorded(err)) {
      void recordProxyTrace({
        context: traceContext,
        model: body.model,
        upstreamUrl: baseUrl,
        upstreamRequest: null,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        error: err,
      }).catch(() => {})
    }
    console.error('[Proxy] Upstream request failed:', err)
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 502 },
    )
  }
}

function applyRedteamWorkflowGuard(
  req: Request,
  body: AnthropicRequest,
): { body: AnthropicRequest; response?: undefined } | { response: Response } {
  const latestUserText = getLatestUserText(body)
  if (!latestUserText) return { body }

  const sessionId = getRedteamSessionId(req, body)
  for (const message of body.messages) {
    recordRedteamWorkflowCliMessage(sessionId, { message })
  }

  const result = prepareRedteamWorkflowPrompt(
    sessionId,
    latestUserText,
    getRedteamWorkDir(req),
  )
  if (!result.injected) return { body }

  if (result.run?.awaitingGate) {
    return {
      response: createAnthropicTextResponse(
        body,
        formatRedteamConfirmationGate(result.run),
      ),
    }
  }

  return {
    body: replaceLatestUserText(body, result.content),
  }
}

function getLatestUserText(body: AnthropicRequest): string {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const message = body.messages[i]
    if (message?.role !== 'user') continue
    return textFromAnthropicContent(message.content).trim()
  }
  return ''
}

function getRedteamSessionId(req: Request, body: AnthropicRequest): string {
  const explicit =
    req.headers.get('x-cc-haha-session-id') ||
    req.headers.get('x-cchaha-session-id') ||
    req.headers.get('x-session-id') ||
    req.headers.get('x-codex-session-id')
  if (explicit?.trim()) return `proxy:${explicit.trim()}`

  const conversationText = body.messages
    .map((message) => textFromAnthropicContent(message.content))
    .join('\n')
  const target = extractTargetHint(conversationText)
  if (target) return `proxy-target:${target}`

  const seed = conversationText || body.model || 'redteam-proxy'
  return `proxy:${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`
}

function getRedteamWorkDir(req: Request): string {
  return (
    req.headers.get('x-cc-haha-work-dir') ||
    req.headers.get('x-cchaha-work-dir') ||
    req.headers.get('x-codex-cwd') ||
    process.cwd()
  )
}

function textFromAnthropicContent(content: AnthropicRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content
  return content.map(textFromAnthropicBlock).filter(Boolean).join('\n')
}

function textFromAnthropicBlock(block: AnthropicContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return block.content
    return block.content.map(textFromAnthropicBlock).filter(Boolean).join('\n')
  }
  if (block.type === 'thinking') return block.thinking
  return ''
}

function replaceLatestUserText(body: AnthropicRequest, text: string): AnthropicRequest {
  const messages = body.messages.slice()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    messages[i] = {
      ...message,
      content: replaceTextContent(message.content, text),
    }
    return { ...body, messages }
  }
  return body
}

function replaceTextContent(
  content: AnthropicRequest['messages'][number]['content'],
  text: string,
): AnthropicRequest['messages'][number]['content'] {
  if (typeof content === 'string') return text

  let replaced = false
  const blocks = content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    return { ...block, text }
  })
  if (replaced) return blocks
  return [{ type: 'text', text }, ...blocks]
}

function extractTargetHint(content: string): string | null {
  const url = content.match(/https?:\/\/[^\s"'<>，。；、？！)）】》\]\u4e00-\u9fff]+/iu)?.[0]
  if (url) return trimTargetHint(url)

  const ip = content.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0]
  if (ip) return ip

  const domain = content.match(/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/i)?.[0]
  return domain ?? null
}

function trimTargetHint(value: string): string {
  return value.replace(/[),.;:!?]+$/g, '').replace(/[、。，；：？！）】》]+$/gu, '')
}

function createAnthropicTextResponse(body: AnthropicRequest, text: string): Response {
  if (body.stream === true) {
    return new Response(createAnthropicTextStream(body, text), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  return Response.json({
    id: `msg_redteam_guard_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: estimateTokenCount(text),
    },
  })
}

function createAnthropicTextStream(body: AnthropicRequest, text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const messageId = `msg_redteam_guard_${Date.now()}`
  return new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: estimateTokenCount(text) },
      })
      send('message_stop', { type: 'message_stop' })
      controller.close()
    },
  })
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

async function maybeRouteToVisionProvider(
  config: ProxyProviderConfig,
  body: AnthropicRequest,
): Promise<{ config: ProxyProviderConfig; body: AnthropicRequest; response?: undefined } | { response: Response }> {
  const router = config.visionRouter
  if (
    !requestHasImage(body) ||
    !router ||
    router.enabled === false ||
    (router.trigger !== undefined && router.trigger !== 'image')
  ) {
    return { config, body }
  }

  const visionConfig = await providerService.getProviderForProxy(router.providerId)
  if (!visionConfig) {
    return {
      response: Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `Vision provider "${router.providerId}" is not configured for proxy`,
          },
        },
        { status: 400 },
      ),
    }
  }

  return {
    config: visionConfig,
    body: {
      ...body,
      model: visionConfig.models.main || body.model,
    },
  }
}

function requestHasImage(body: AnthropicRequest): boolean {
  return body.messages.some((message) => contentHasImage(message.content))
}

function contentHasImage(content: AnthropicRequest['messages'][number]['content']): boolean {
  if (typeof content === 'string') return false
  return blocksHaveImage(content)
}

function blocksHaveImage(blocks: AnthropicContentBlock[]): boolean {
  return blocks.some((block) => {
    if (block.type === 'image') return true
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return blocksHaveImage(block.content)
    }
    return false
  })
}

async function handleAnthropic(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  authStrategy: ProxyProviderConfig['authStrategy'],
  isStream: boolean,
  aiRequestTimeoutMs: number,
  proxyUrl: string | undefined,
): Promise<Response> {
  const url = `${baseUrl}/v1/messages`
  const proxyOptions = getProxyFetchOptions({ proxyUrl })
  const upstream = await fetchUpstreamWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...buildAnthropicAuthHeaders(apiKey, authStrategy),
    },
    body: JSON.stringify(body),
    ...proxyOptions,
  }, aiRequestTimeoutMs, isStream)

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
        },
      },
      { status: upstream.status },
    )
  }

  if (isStream) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'text/event-stream',
        'Cache-Control': upstream.headers.get('Cache-Control') ?? 'no-cache',
      },
    })
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    },
  })
}

function buildAnthropicAuthHeaders(
  apiKey: string,
  authStrategy: ProxyProviderConfig['authStrategy'],
): Record<string, string> {
  switch (authStrategy) {
    case 'api_key':
      return { 'x-api-key': apiKey }
    case 'dual_same_token':
      return { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` }
    case 'dual_dummy':
      return { 'x-api-key': 'dummy', Authorization: 'Bearer dummy' }
    case 'auth_token':
    case 'auth_token_empty_api_key':
    default:
      return { Authorization: `Bearer ${apiKey}` }
  }
}

async function handleOpenaiChat(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  aiRequestTimeoutMs: number,
  proxyUrl: string | undefined,
  traceContext: ProxyTraceContext | null,
): Promise<Response> {
  const deepSeekCompatible = shouldUseDeepSeekReasoningCompat(baseUrl)
  const transformed = anthropicToOpenaiChat(body, {
    roundTripReasoningContent: deepSeekCompatible,
    passThinkingToggle: deepSeekCompatible,
    imageContentMode: shouldUseTextOnlyOpenAIChatContent(baseUrl) ? 'text_only' : 'vision',
  })
  const url = `${baseUrl}/v1/chat/completions`
  const proxyOptions = getProxyFetchOptions({ proxyUrl })
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        startedAt,
      })
    : undefined

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(transformed),
      ...proxyOptions,
    }, aiRequestTimeoutMs, isStream)
  } catch (err) {
    if (traceContext) {
      await recordProxyTrace({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        startedAt,
        startedAtMs,
        error: err,
      })
      markTraceErrorRecorded(err)
    }
    throw err
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    const errorBody = {
      type: 'error',
      error: {
        type: 'api_error',
        message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
      },
    }
    if (traceContext) {
      await recordProxyTrace({
        context: traceContext,
        callId: traceCallId,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        startedAt,
        startedAtMs,
        responseStatus: upstream.status,
        upstreamResponseBody: errText,
        anthropicResponseBody: errorBody,
        responseHeaders: upstream.headers,
      })
    }
    return Response.json(
      errorBody,
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      if (traceContext) {
        await recordProxyTrace({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
          startedAt,
          startedAtMs,
          error: new Error('Upstream returned no body for stream'),
        })
      }
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const upstreamBody = withStreamIdleTimeout(upstream.body, aiRequestTimeoutMs)
    const anthropicStream = openaiChatStreamToAnthropic(upstreamBody, body.model)
    const tracedStream = traceContext
      ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
          await recordProxyTrace({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
            startedAt,
            startedAtMs,
            responseStatus: 200,
            responseBodySnapshot: bodySnapshot,
            responseHeaders: upstream.headers,
            ...(error ? { error } : {}),
          })
        })
      : anthropicStream
    return new Response(tracedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const anthropicResponse = openaiChatToAnthropic(responseBody, body.model)
  if (traceContext) {
    await recordProxyTrace({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      startedAt,
      startedAtMs,
      responseStatus: 200,
      upstreamResponseBody: responseBody,
      anthropicResponseBody: anthropicResponse,
      responseHeaders: upstream.headers,
    })
  }
  return Response.json(anthropicResponse)
}

function shouldUseDeepSeekReasoningCompat(baseUrl: string): boolean {
  return (
    /(^|[./-])deepseek([./-]|$)/i.test(baseUrl) ||
    /(^|[./-])opencode\.ai([:/]|$)/i.test(baseUrl)
  )
}

function shouldUseTextOnlyOpenAIChatContent(baseUrl: string): boolean {
  return shouldUseDeepSeekReasoningCompat(baseUrl)
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  aiRequestTimeoutMs: number,
  proxyUrl: string | undefined,
  traceContext: ProxyTraceContext | null,
  promptCacheKey?: string,
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body, { cacheKey: promptCacheKey })
  const url = `${baseUrl}/v1/responses`
  const proxyOptions = getProxyFetchOptions({ proxyUrl })
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        startedAt,
      })
    : undefined

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(transformed),
      ...proxyOptions,
    }, aiRequestTimeoutMs, isStream)
  } catch (err) {
    if (traceContext) {
      await recordProxyTrace({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        startedAt,
        startedAtMs,
        error: err,
      })
      markTraceErrorRecorded(err)
    }
    throw err
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    const errorBody = {
      type: 'error',
      error: {
        type: 'api_error',
        message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
      },
    }
    if (traceContext) {
      await recordProxyTrace({
        context: traceContext,
        callId: traceCallId,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        startedAt,
        startedAtMs,
        responseStatus: upstream.status,
        upstreamResponseBody: errText,
        anthropicResponseBody: errorBody,
        responseHeaders: upstream.headers,
      })
    }
    return Response.json(
      errorBody,
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      if (traceContext) {
        await recordProxyTrace({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
          startedAt,
          startedAtMs,
          error: new Error('Upstream returned no body for stream'),
        })
      }
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const upstreamBody = withStreamIdleTimeout(upstream.body, aiRequestTimeoutMs)
    const anthropicStream = openaiResponsesStreamToAnthropic(upstreamBody, body.model)
    const tracedStream = traceContext
      ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
          await recordProxyTrace({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
            startedAt,
            startedAtMs,
            responseStatus: 200,
            responseBodySnapshot: bodySnapshot,
            responseHeaders: upstream.headers,
            ...(error ? { error } : {}),
          })
        })
      : anthropicStream
    return new Response(tracedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const anthropicResponse = openaiResponsesToAnthropic(responseBody, body.model)
  if (traceContext) {
    await recordProxyTrace({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      startedAt,
      startedAtMs,
      responseStatus: 200,
      upstreamResponseBody: responseBody,
      anthropicResponseBody: anthropicResponse,
      responseHeaders: upstream.headers,
    })
  }
  return Response.json(anthropicResponse)
}

function buildProxyTraceContext(
  req: Request,
  config: { id: string; name: string; apiFormat: string },
  anthropicRequest: AnthropicRequest,
): ProxyTraceContext | null {
  const sessionId = req.headers.get('x-claude-code-session-id')?.trim()
  if (!sessionId) return null
  return {
    sessionId,
    provider: {
      id: config.id,
      name: config.name,
      format: config.apiFormat,
    },
    anthropicRequest,
  }
}

function createProxyTraceRequestBody(context: ProxyTraceContext, upstreamRequest: unknown): Record<string, unknown> {
  return upstreamRequest
    ? {
        anthropic: context.anthropicRequest,
        upstream: upstreamRequest,
      }
    : {
        anthropic: context.anthropicRequest,
      }
}

function startProxyTraceCall({
  context,
  model,
  upstreamUrl,
  upstreamRequest,
  startedAt,
}: {
  context: ProxyTraceContext
  model: string
  upstreamUrl: string
  upstreamRequest: unknown
  startedAt: string
}): string {
  const callId = createTraceCallId()
  void traceCaptureService.recordCall({
    id: callId,
    sessionId: context.sessionId,
    source: 'proxy',
    provider: context.provider,
    model,
    status: 'pending',
    startedAt,
    request: {
      method: 'POST',
      url: upstreamUrl,
      bodySnapshot: createTraceBodySnapshot({
        pending: true,
        note: 'proxy request body captured on call completion',
      }),
    },
    metadata: {
      phase: 'upstream_fetch_started',
    },
  })
  void traceCaptureService.recordEvent({
    sessionId: context.sessionId,
    callId,
    source: 'proxy',
    provider: context.provider,
    model,
    timestamp: startedAt,
    phase: 'upstream_fetch_started',
    severity: 'info',
    title: 'Upstream fetch started',
    metadata: {
      url: upstreamUrl,
    },
  })
  return callId
}

async function recordProxyTrace({
  callId,
  context,
  model,
  upstreamUrl,
  upstreamRequest,
  startedAt,
  startedAtMs,
  responseStatus,
  upstreamResponseBody,
  anthropicResponseBody,
  responseBodySnapshot,
  responseHeaders,
  error,
}: {
  callId?: string
  context: ProxyTraceContext
  model: string
  upstreamUrl: string
  upstreamRequest: unknown
  startedAt: string
  startedAtMs: number
  responseStatus?: number
  upstreamResponseBody?: unknown
  anthropicResponseBody?: unknown
  responseBodySnapshot?: TraceBodySnapshot
  responseHeaders?: Headers
  error?: unknown
}): Promise<void> {
  const completedAt = new Date().toISOString()
  const requestBody = createProxyTraceRequestBody(context, upstreamRequest)
  const responseBody = anthropicResponseBody === undefined && upstreamResponseBody === undefined
    ? undefined
    : {
        ...(upstreamResponseBody !== undefined ? { upstream: upstreamResponseBody } : {}),
        ...(anthropicResponseBody !== undefined ? { anthropic: anthropicResponseBody } : {}),
      }

  await traceCaptureService.recordCall({
    ...(callId ? { id: callId } : {}),
    sessionId: context.sessionId,
    source: 'proxy',
    provider: context.provider,
    model,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedAtMs,
    request: {
      method: 'POST',
      url: upstreamUrl,
      body: requestBody,
    },
    ...(responseStatus !== undefined
      ? {
          response: {
            status: responseStatus,
            headers: responseHeaders,
            ...(responseBodySnapshot ? { bodySnapshot: responseBodySnapshot } : { body: responseBody }),
          },
        }
      : {}),
    ...(error ? { error } : {}),
    metadata: {
      phase: error ? 'upstream_fetch_failed' : 'upstream_fetch_completed',
    },
  })
  await traceCaptureService.recordEvent({
    sessionId: context.sessionId,
    ...(callId ? { callId } : {}),
    source: 'proxy',
    provider: context.provider,
    model,
    timestamp: completedAt,
    phase: error ? 'upstream_fetch_failed' : 'upstream_fetch_completed',
    severity: error ? 'error' : responseStatus !== undefined && responseStatus >= 400 ? 'warning' : 'info',
    title: error ? 'Upstream fetch failed' : 'Upstream fetch completed',
    message: error instanceof Error ? error.message : error ? String(error) : undefined,
    metadata: {
      status: responseStatus,
      url: upstreamUrl,
    },
  })
}

function captureTraceStream(
  stream: ReadableStream<Uint8Array>,
  onComplete: (snapshot: TraceBodySnapshot, error?: unknown) => Promise<void>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let captured = ''
  let bytes = 0
  let truncated = false
  let finalized = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const captureChunk = (chunk: Uint8Array) => {
    bytes += chunk.byteLength
    if (bytes <= TRACE_STREAM_CAPTURE_BYTES) {
      captured += decoder.decode(chunk, { stream: true })
    } else {
      truncated = true
    }
  }

  const finalize = async (error?: unknown) => {
    if (finalized) return
    finalized = true
    captured += decoder.decode()
    const snapshot = createTraceBodySnapshot(captured, { alreadyTruncated: truncated })
    await onComplete(snapshot, error).catch(() => {})
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          captureChunk(value)
          controller.enqueue(value)
        }
        await finalize()
        controller.close()
      } catch (err) {
        await finalize(err)
        controller.error(err)
      } finally {
        reader?.releaseLock()
        reader = null
      }
    },
    async cancel(reason) {
      const error = reason instanceof Error
        ? reason
        : new Error(reason ? `Stream cancelled: ${String(reason)}` : 'Stream cancelled')
      await finalize(error)
      await reader?.cancel(reason).catch(() => undefined)
    },
  })
}
