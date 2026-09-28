import Anthropic from '@anthropic-ai/sdk';
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

import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL: string;
  timeoutMs: number;
  defaults: LlmDefaults;
  /** Server-side refusal fallbacks; enable only for models that support them. */
  refusalFallbacks: boolean;
}

function toParam(message: LlmMessage): BetaMessageParam {
  if (message.role === 'assistant' && message.raw) {
    return { role: 'assistant', content: message.raw as BetaContentBlockParam[] };
  }
  const content: BetaContentBlockParam[] = message.content.map((b) => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> };
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
    }
  });
  return { role: message.role, content };
}

function mapStop(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
    case 'pause_turn':
      return reason;
    default:
      return 'other';
  }
}

export function toLlmError(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError('auth', false, message, 'anthropic', err.status);
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate_limit', true, message, 'anthropic', 429);
  if (err instanceof Anthropic.BadRequestError) {
    // Anthropic reports an exhausted balance as an invalid request; it needs a human, not a retry.
    const billing = /credit balance/i.test(message);
    return new LlmError(billing ? 'billing' : 'invalid_request', false, message, 'anthropic', 400);
  }
  if (err instanceof Anthropic.NotFoundError) return new LlmError('invalid_request', false, message, 'anthropic', 404);
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) {
    return new LlmError('unavailable', true, message, 'anthropic');
  }
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === 529 || err.status === 408 || (err.status ?? 0) >= 500;
    return new LlmError(retryable ? 'unavailable' : 'unknown', retryable, message, 'anthropic', err.status);
  }
  return err;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly info: LlmInfo;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 3, timeout: opts.timeoutMs });
    this.info = describeDefaults('anthropic', opts.defaults);
  }

  async generate(request: LlmRequest, options: GenerateOptions = {}): Promise<LlmResponse> {
    const { model, reasoningEffort } = resolveTarget(this.info, request);
    try {
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: request.maxTokens,
          // One explicit breakpoint at the end of the static prefix (tools + system): stable per bot
          // version, so every turn of every conversation for this bot reads it from cache.
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as BetaTool.InputSchema,
          })),
          messages: request.messages.map(toParam),
          ...(reasoningEffort ? { output_config: { effort: reasoningEffort } } : {}),
          ...(this.opts.refusalFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: options.signal },
      );
      if (options.onText) stream.on('text', options.onText);
      const message = await stream.finalMessage();

      const content: LlmContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
      return {
        content,
        raw: message.content,
        stopReason: mapStop(message.stop_reason),
        model,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (err) {
      throw toLlmError(err);
    }
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    const models = [...new Set([this.info.model, this.info.utilityModel])];
    try {
      for (const m of models) await this.client.models.retrieve(m);
      return { ok: true, message: `Anthropic key accepted; ${models.join(', ')} available` };
    } catch (err) {
      const e = toLlmError(err);
      return { ok: false, message: e instanceof LlmError ? `${e.kind}: ${e.message}` : String(e) };
    }
  }
}
