import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type {
  FunctionTool,
  Response as OpenAIResponse,
  ResponseInputItem,
  ResponseOutputItem,
} from 'openai/resources/responses/responses';
import {
  describeDefaults,
  LlmError,
  resolveTarget,
  type GenerateOptions,
  type LlmContentBlock,
  type LlmDefaults,
  type LlmInfo,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
} from './types';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL: string;
  timeoutMs: number;
  defaults: LlmDefaults;
}

/** Our provider-neutral turns → Responses API input items. */
export function toOpenAIInput(messages: LlmMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.raw)) {
      // Replay the model's own output items (reasoning, function calls, messages) unchanged.
      items.push(...toResponseInputItems(message.raw as ResponseOutputItem[]));
      continue;
    }
    let text: string[] = [];
    const flushText = () => {
      if (text.length) items.push({ role: message.role, content: text.join('\n\n') });
      text = [];
    };
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'tool_result') {
        flushText();
        items.push({ type: 'function_call_output', call_id: block.toolUseId, output: block.content });
      } else {
        flushText();
        items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      }
    }
    flushText();
  }
  return items;
}

/** Responses API result → provider-neutral response. */
export function fromOpenAIResponse(response: OpenAIResponse, model: string): LlmResponse {
  const content: LlmContentBlock[] = [];
  let refused = false;
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text') content.push({ type: 'text', text: part.text });
        else if (part.type === 'refusal') refused = true;
      }
    } else if (item.type === 'function_call') {
      let input: unknown;
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        // Left as the raw string: tool validation rejects it and the model is told why.
        input = item.arguments;
      }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
    }
  }
  const hasToolCalls = content.some((b) => b.type === 'tool_use');
  const hasText = content.some((b) => b.type === 'text');
  const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined;
  let stopReason: LlmStopReason;
  if ((refused && !hasText && !hasToolCalls) || incomplete === 'content_filter') stopReason = 'refusal';
  else if (incomplete === 'max_output_tokens') stopReason = 'max_tokens';
  else if (hasToolCalls) stopReason = 'tool_use';
  else stopReason = response.status === 'completed' || !response.status ? 'end_turn' : 'other';

  const usage = response.usage;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const written = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    content,
    raw: response.output,
    stopReason,
    // Priced and recorded under the configured id (the API may report a dated snapshot).
    model,
    usage: {
      inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - cached - written),
      cacheReadTokens: cached,
      cacheWriteTokens: written,
      outputTokens: usage?.output_tokens ?? 0,
    },
  };
}

export function toLlmError(err: unknown): unknown {
  if (err instanceof OpenAI.APIUserAbortError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError('auth', false, message, 'openai', err.status);
  }
  if (err instanceof OpenAI.RateLimitError) {
    // OpenAI reports an exhausted balance as 429 too; retrying that only burns time.
    return err.code === 'insufficient_quota'
      ? new LlmError('billing', false, message, 'openai', 429)
      : new LlmError('rate_limit', true, message, 'openai', 429);
  }
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.NotFoundError || err instanceof OpenAI.UnprocessableEntityError) {
    return new LlmError('invalid_request', false, message, 'openai', err.status);
  }
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.InternalServerError) {
    return new LlmError('unavailable', true, message, 'openai');
  }
  if (err instanceof OpenAI.APIError) {
    const retryable = (err.status ?? 0) >= 500 || err.status === 408 || err.status === 409;
    return new LlmError(retryable ? 'unavailable' : 'unknown', retryable, message, 'openai', err.status);
  }
  return err;
}

/**
 * OpenAI via the Responses API (required for tool calling with reasoning models). Conversations are
 * not stored by OpenAI (`store: false`); reasoning items travel back encrypted within a tool loop.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  readonly info: LlmInfo;
  private readonly client: OpenAI;
  /** Models that rejected the encrypted-reasoning include (non-reasoning models may). Learned at runtime. */
  private readonly noReasoningInclude = new Set<string>();

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs, maxRetries: 2 });
    this.info = describeDefaults('openai', opts.defaults);
  }

  async generate(request: LlmRequest, options: GenerateOptions = {}): Promise<LlmResponse> {
    const { model, reasoningEffort } = resolveTarget(this.info, request);
    const input = toOpenAIInput(request.messages);
    const tools: FunctionTool[] = request.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      // Arguments are validated server-side against the same schema, so non-strict mode is enough
      // and keeps optional fields natural.
      strict: false,
    }));
    const run = async (withReasoningInclude: boolean) => {
      const stream = this.client.responses.stream(
        {
          model,
          instructions: request.system,
          input,
          ...(tools.length ? { tools } : {}),
          max_output_tokens: request.maxTokens,
          store: false,
          ...(withReasoningInclude ? { include: ['reasoning.encrypted_content' as const] } : {}),
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        },
        { signal: options.signal },
      );
      if (options.onText) {
        const onText = options.onText;
        stream.on('response.output_text.delta', (event) => onText(event.delta));
      }
      return stream.finalResponse();
    };
    try {
      const withInclude = !this.noReasoningInclude.has(model);
      let response: OpenAIResponse;
      try {
        response = await run(withInclude);
      } catch (err) {
        if (withInclude && err instanceof OpenAI.BadRequestError && err.param === 'include') {
          this.noReasoningInclude.add(model);
          response = await run(false);
        } else {
          throw err;
        }
      }
      return fromOpenAIResponse(response, model);
    } catch (err) {
      throw toLlmError(err);
    }
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    const models = [...new Set([this.info.model, this.info.utilityModel])];
    try {
      for (const m of models) await this.client.models.retrieve(m);
      return { ok: true, message: `OpenAI key accepted; ${models.join(', ')} available` };
    } catch (err) {
      const e = toLlmError(err);
      return { ok: false, message: e instanceof LlmError ? `${e.kind}: ${e.message}` : String(e) };
    }
  }
}
