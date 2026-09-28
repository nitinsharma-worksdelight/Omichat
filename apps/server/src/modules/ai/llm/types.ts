import type { ToolSpec } from '../../tools/executor';

/** Provider-neutral reasoning depth. Each provider maps it to its own parameter, or omits it. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContentBlock[];
  /**
   * Provider-native assistant output, replayed verbatim inside a tool loop so opaque items
   * (reasoning, fallback markers) round-trip unchanged.
   */
  raw?: unknown;
}

export interface LlmRequest {
  /** Stable, cacheable instructions (persona, rules, business facts). No per-request data. */
  system: string;
  tools: ToolSpec[];
  messages: LlmMessage[];
  maxTokens: number;
  /** `reply` = customer-facing turns; `utility` = background work such as summaries. */
  tier?: 'reply' | 'utility';
  /** Per-bot override. Omit to use the configured model for the tier. */
  model?: string;
  /** Per-bot override. Omit to use the configured effort for the tier (which may be none). */
  reasoningEffort?: ReasoningEffort;
}

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

/** Normalized token accounting: `inputTokens` excludes cache reads and cache writes. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  content: LlmContentBlock[];
  raw: unknown;
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /** The model that actually served the response. */
  model: string;
}

export interface GenerateOptions {
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

/** What the server is configured to use; exposed to the dashboard and logs. */
export interface LlmInfo {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  utilityModel: string;
  utilityReasoningEffort: ReasoningEffort | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly info: LlmInfo;
  generate(request: LlmRequest, opts?: GenerateOptions): Promise<LlmResponse>;
  /** Cheap startup check (key valid, model reachable). Never throws. */
  verify?(): Promise<{ ok: boolean; message: string }>;
}

/** Configured defaults a provider falls back to when a request carries no override. */
export interface LlmDefaults {
  model: string;
  reasoningEffort?: ReasoningEffort;
  utilityModel?: string;
  utilityReasoningEffort?: ReasoningEffort;
}

export function describeDefaults(provider: string, d: LlmDefaults): LlmInfo {
  return {
    provider,
    model: d.model,
    reasoningEffort: d.reasoningEffort ?? null,
    utilityModel: d.utilityModel ?? d.model,
    // A separate utility model gets only its own effort: the main model's may not apply to it.
    utilityReasoningEffort: (d.utilityModel ? d.utilityReasoningEffort : (d.utilityReasoningEffort ?? d.reasoningEffort)) ?? null,
  };
}

/** Resolves the model and effort for one request from overrides and configured defaults. */
export function resolveTarget(info: LlmInfo, request: LlmRequest): { model: string; reasoningEffort: ReasoningEffort | null } {
  if (request.tier === 'utility') {
    return { model: request.model ?? info.utilityModel, reasoningEffort: request.reasoningEffort ?? info.utilityReasoningEffort };
  }
  return { model: request.model ?? info.model, reasoningEffort: request.reasoningEffort ?? info.reasoningEffort };
}

export type LlmErrorKind = 'auth' | 'billing' | 'rate_limit' | 'invalid_request' | 'unavailable' | 'unknown';

/**
 * Provider failures, normalized so the engine never needs to know which SDK raised them.
 * `auth` and `billing` need a human to fix configuration; retrying won't help.
 */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    readonly retryable: boolean,
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export const textOf = (content: LlmContentBlock[]): string =>
  content
    .filter((b): b is Extract<LlmContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
