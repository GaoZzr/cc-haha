/**
 * Request transformation: Anthropic Messages → OpenAI Responses API
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicMessage,
  OpenAIResponsesRequest,
  OpenAIResponsesInputItem,
  OpenAIResponsesContentPart,
} from './types.js'

/**
 * Convert Anthropic Messages request to OpenAI Responses API request.
 */
export function anthropicToOpenaiResponses(body: AnthropicRequest): OpenAIResponsesRequest {
  const input: OpenAIResponsesInputItem[] = []

  // Convert messages to input items
  for (const msg of body.messages) {
    convertMessageToInputItems(msg, input)
  }

  const result: OpenAIResponsesRequest = {
    model: body.model,
    input,
    stream: body.stream,
    store: false,
  }

  // system → instructions
  if (body.system) {
    if (typeof body.system === 'string') {
      result.instructions = body.system
    } else if (Array.isArray(body.system)) {
      result.instructions = body.system.map((b) => b.text).join('\n')
    }
  }

  // max_tokens — omit to let upstream provider use its own default/max.
  // Claude Code sends very large values that exceed many providers' limits.

  // GPT/Codex Responses models reject sampling params that the Anthropic SDK
  // may send for side queries or forked agents.

  // tools
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools
      .filter((t) => t.name !== 'BatchTool')
      .map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }))
  }

  // tool_choice
  if (body.tool_choice !== undefined) {
    result.tool_choice = convertToolChoice(body.tool_choice)
  }

  // thinking → reasoning
  const effort = convertEffort(body.output_config?.effort)
  if (effort) {
    result.reasoning = { effort }
  } else if (body.thinking) {
    const budget = body.thinking.budget_tokens
    if (budget !== undefined) {
      if (budget <= 1024) result.reasoning = { effort: 'low' }
      else if (budget <= 8192) result.reasoning = { effort: 'medium' }
      else result.reasoning = { effort: 'high' }
    } else if (body.thinking.type === 'enabled') {
      result.reasoning = { effort: 'high' }
    }
  }

  // stop_sequences not supported in Responses API, dropped

  return result
}

type OpenAIResponsesReasoningEffort = NonNullable<
  OpenAIResponsesRequest['reasoning']
>['effort']

function convertEffort(
  effort: string | null | undefined,
): OpenAIResponsesReasoningEffort | undefined {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
      return effort
    case 'max':
    case 'xhigh':
      return 'xhigh'
    default:
      return undefined
  }
}

function convertMessageToInputItems(msg: AnthropicMessage, output: OpenAIResponsesInputItem[]): void {
  const content = msg.content

  // Simple string content
  if (typeof content === 'string') {
    output.push({ type: 'message', role: msg.role, content })
    return
  }

  if (!Array.isArray(content) || content.length === 0) {
    output.push({ type: 'message', role: msg.role, content: '' })
    return
  }

  // Collect text/image parts and handle tool blocks separately.
  const contentParts: ResponsePendingContentPart[] = []

  for (const block of content) {
    if (block.type === 'text') {
      contentParts.push({ kind: 'text', text: block.text })
    } else if (block.type === 'image') {
      contentParts.push({ kind: 'image', image: block })
    } else if (block.type === 'tool_use') {
      // Flush any accumulated content first
      flushResponseContentParts(msg.role, contentParts, output)
      // Lift to function_call item
      output.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
      })
    } else if (block.type === 'tool_result') {
      // Lift to function_call_output item
      const resultContent = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n')
          : ''
      const resultImages = Array.isArray(block.content)
        ? block.content.filter((b): b is Extract<AnthropicContentBlock, { type: 'image' }> => b.type === 'image')
        : []
      output.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: resultContent || (resultImages.length > 0 ? '[image output]' : ''),
      })
      if (resultImages.length > 0) {
        output.push({
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: `Image output from tool call ${block.tool_use_id}.` },
            ...resultImages.map((image) => toResponsesImagePart(image)),
          ],
        })
      }
    }
    // Skip thinking blocks
  }

  // Flush remaining content
  flushResponseContentParts(msg.role, contentParts, output)
}

type ResponsePendingContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: Extract<AnthropicContentBlock, { type: 'image' }> }

function flushResponseContentParts(
  role: AnthropicMessage['role'],
  parts: ResponsePendingContentPart[],
  output: OpenAIResponsesInputItem[],
): void {
  if (parts.length === 0) return

  const hasImage = parts.some((part) => part.kind === 'image')
  if (!hasImage) {
    const text = parts
      .filter((part): part is Extract<ResponsePendingContentPart, { kind: 'text' }> => part.kind === 'text')
      .map((part) => part.text)
      .join('')
    if (text) {
      output.push({ type: 'message', role, content: text })
    }
    parts.length = 0
    return
  }

  const content: OpenAIResponsesContentPart[] = []
  for (const part of parts) {
    if (part.kind === 'text') {
      const text = part.text
      if (text) content.push(role === 'assistant'
        ? { type: 'output_text', text }
        : { type: 'input_text', text })
    } else {
      content.push(toResponsesImagePart(part.image))
    }
  }
  if (content.length > 0) {
    output.push({ type: 'message', role, content })
  }
  parts.length = 0
}

function toResponsesImagePart(
  image: Extract<AnthropicContentBlock, { type: 'image' }>,
): OpenAIResponsesContentPart {
  return {
    type: 'input_image',
    image_url: `data:${image.source.media_type};base64,${image.source.data}`,
  }
}

function convertToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice
  if (typeof choice === 'object' && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === 'auto') return 'auto'
    if (c.type === 'any') return 'required'
    if (c.type === 'none') return 'none'
    if (c.type === 'tool' && typeof c.name === 'string') {
      return { type: 'function', function: { name: c.name } }
    }
  }
  return 'auto'
}
