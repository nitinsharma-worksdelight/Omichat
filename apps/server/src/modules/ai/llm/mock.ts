import { describeDefaults, resolveTarget, type GenerateOptions, type LlmDefaults, type LlmInfo, type LlmProvider, type LlmRequest, type LlmResponse } from './types';

type MockResult = Omit<LlmResponse, 'raw' | 'usage' | 'model'> & Partial<Pick<LlmResponse, 'usage'>>;

/** One scripted model call. It may be async and receives the call options, e.g. to hang until `opts.signal` aborts. */
export type MockTurn = (request: LlmRequest, call: number, opts: GenerateOptions) => MockResult | Promise<MockResult>;

/**
 * Deterministic provider for tests and for running locally without an API key. Tests script it
 * turn by turn; without a script it gives a clearly-labelled canned reply so the whole pipeline
 * (queue → orchestrator → streaming → persistence) can be exercised end to end.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly info: LlmInfo;
  readonly requests: LlmRequest[] = [];
  private script: MockTurn[] = [];
  private calls = 0;

  constructor(defaults: LlmDefaults = { model: 'mock' }) {
    this.info = describeDefaults('mock', defaults);
  }

  setScript(turns: MockTurn[]): void {
    this.script = [...turns];
    this.calls = 0;
    this.requests.length = 0;
  }

  async generate(request: LlmRequest, opts: GenerateOptions = {}): Promise<LlmResponse> {
    this.requests.push(structuredClone(request));
    const turn = this.script.shift();
    const call = this.calls++;
    const result: MockResult = turn
      ? await turn(request, call, opts)
      : {
          content: [
            {
              type: 'text' as const,
              text: '(Demo mode: no LLM provider is configured, so this is a placeholder reply. Set LLM_PROVIDER, LLM_MODEL and the provider API key in .env to talk to the real assistant.)',
            },
          ],
          stopReason: 'end_turn' as const,
        };
    for (const block of result.content) {
      if (block.type === 'text' && opts.onText) {
        for (const word of block.text.split(/(?<=\s)/)) opts.onText(word);
      }
    }
    return {
      ...result,
      raw: undefined,
      model: resolveTarget(this.info, request).model,
      usage: result.usage ?? { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
