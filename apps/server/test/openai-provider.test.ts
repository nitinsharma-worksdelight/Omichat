import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../src/modules/ai/llm/openai';
import { LlmError } from '../src/modules/ai/llm/types';
import { createOrg, createTestEnv, type TestEnv } from './helpers';

/**
 * A local stand-in for the OpenAI Responses API that speaks the same SSE wire format, so the real SDK
 * and our provider run end to end without network access or cost.
 */
type Reply =
  | { kind: 'text'; text: string; usage?: Usage }
  | { kind: 'tools'; calls: Array<{ name: string; args: unknown }>; reasoning?: boolean; usage?: Usage }
  | { kind: 'refusal'; text: string }
  | { kind: 'incomplete'; text: string }
  | { kind: 'error'; status: number; body: unknown };
type Usage = { input: number; cached: number; written: number; output: number };

let server: Server;
let baseURL: string;
const requests: Array<Record<string, any>> = [];
let script: Reply[] = [];
let seq = 0;

function responseObject(model: string, output: unknown[], status = 'completed', usage: Usage = { input: 1200, cached: 1000, written: 0, output: 40 }, incomplete: unknown = null) {
  return {
    id: `resp_${++seq}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: `${model}-2024-07-18`,
    output,
    incomplete_details: incomplete,
    error: null,
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: usage.cached, cache_write_tokens: usage.written },
      output_tokens: usage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input + usage.output,
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (req.method === 'GET' && req.url?.startsWith('/v1/models/')) {
      const id = decodeURIComponent(req.url.slice('/v1/models/'.length));
      if (id === 'missing-model') {
        res.writeHead(404, { 'content-type': 'application/json', 'x-should-retry': 'false' }).end(JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error' } }));
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, object: 'model' }));
      return;
    }
    requests.push(body);
    const reply = script.shift() ?? { kind: 'text', text: 'default' };
    if (reply.kind === 'error') {
      res.writeHead(reply.status, { 'content-type': 'application/json', 'x-should-retry': 'false' }).end(JSON.stringify(reply.body));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ sequence_number: seq++, ...event })}\n\n`);
    const model = body.model as string;
    send({ type: 'response.created', response: { ...responseObject(model, [], 'in_progress'), usage: null } });
    let output: unknown[] = [];
    if (reply.kind === 'text' || reply.kind === 'incomplete') {
      const words = reply.text.split(/(?<= )/);
      send({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } });
      send({ type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      for (const w of words) send({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: w, logprobs: [] });
      output = [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] }];
    } else if (reply.kind === 'refusal') {
      output = [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: reply.text }] }];
    } else {
      output = [
        ...(reply.reasoning ? [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENCRYPTED-REASONING' }] : []),
        ...reply.calls.map((c, i) => ({ type: 'function_call', id: `fc_${seq}_${i}`, call_id: `call_${seq}_${i}`, name: c.name, arguments: JSON.stringify(c.args), status: 'completed' })),
      ];
    }
    const final =
      reply.kind === 'incomplete'
        ? responseObject(model, output, 'incomplete', undefined, { reason: 'max_output_tokens' })
        : responseObject(model, output, 'completed', 'usage' in reply ? reply.usage : undefined);
    send({ type: reply.kind === 'incomplete' ? 'response.incomplete' : 'response.completed', response: final });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const provider = (defaults = { model: 'gpt-4o-mini' } as { model: string; reasoningEffort?: 'low'; utilityModel?: string }) =>
  new OpenAIProvider({ apiKey: 'sk-test', baseURL, timeoutMs: 10_000, defaults });

const baseRequest = { system: 'You are a helpful assistant.', tools: [], maxTokens: 500, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi' }] }] };

describe('OpenAI provider (Responses API)', () => {
  it('uses the configured model, streams text, and normalizes usage', async () => {
    requests.length = 0;
    script = [{ kind: 'text', text: 'Hello there, how can I help?', usage: { input: 1500, cached: 1024, written: 0, output: 12 } }];
    const deltas: string[] = [];
    const res = await provider().generate(baseRequest, { onText: (t) => deltas.push(t) });
    expect(deltas.join('')).toBe('Hello there, how can I help?');
    expect(res).toMatchObject({ stopReason: 'end_turn', model: 'gpt-4o-mini', content: [{ type: 'text', text: 'Hello there, how can I help?' }] });
    expect(res.usage).toEqual({ inputTokens: 476, cacheReadTokens: 1024, cacheWriteTokens: 0, outputTokens: 12 });
    const body = requests[0]!;
    expect(body).toMatchObject({ model: 'gpt-4o-mini', instructions: 'You are a helpful assistant.', store: false, max_output_tokens: 500, stream: true });
    expect(body.reasoning).toBeUndefined(); // no effort configured → not sent
    expect(body.input).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('sends reasoning effort and per-request overrides only when set', async () => {
    requests.length = 0;
    script = [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }, { kind: 'text', text: 'c' }];
    const p = provider({ model: 'main-model', reasoningEffort: 'low', utilityModel: 'cheap-model' });
    await p.generate(baseRequest);
    await p.generate({ ...baseRequest, model: 'bot-override', reasoningEffort: 'high' });
    await p.generate({ ...baseRequest, tier: 'utility' });
    expect(requests.map((r) => [r.model, r.reasoning?.effort])).toEqual([
      ['main-model', 'low'],
      ['bot-override', 'high'],
      ['cheap-model', undefined], // a separate utility model does not inherit the main model's effort
    ]);
  });

  it('maps tools, replays reasoning + calls, and returns function outputs', async () => {
    requests.length = 0;
    script = [
      { kind: 'tools', reasoning: true, calls: [{ name: 'check_availability', args: { date_from: '2026-09-29' } }] },
      { kind: 'text', text: 'Tuesday at 10:00 is open.' },
    ];
    const p = provider();
    const tools = [{ name: 'check_availability', description: 'Look up slots', inputSchema: { type: 'object', properties: { date_from: { type: 'string' } } } }];
    const first = await p.generate({ ...baseRequest, tools });
    expect(first.stopReason).toBe('tool_use');
    const call = first.content.find((b) => b.type === 'tool_use')!;
    expect(call).toMatchObject({ name: 'check_availability', input: { date_from: '2026-09-29' } });
    expect(requests[0]!.tools).toEqual([{ type: 'function', name: 'check_availability', description: 'Look up slots', parameters: tools[0]!.inputSchema, strict: false }]);
    expect(requests[0]!.include).toEqual(['reasoning.encrypted_content']);

    await p.generate({
      ...baseRequest,
      tools,
      messages: [
        ...baseRequest.messages,
        { role: 'assistant', content: first.content, raw: first.raw },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: (call as { id: string }).id, content: '{"slots":["10:00"]}', isError: false }] },
      ],
    });
    const input = requests[1]!.input as Array<Record<string, unknown>>;
    expect(input.map((i) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(input[1]).toMatchObject({ encrypted_content: 'ENCRYPTED-REASONING' });
    expect(input[3]).toEqual({ type: 'function_call_output', call_id: (call as { id: string }).id, output: '{"slots":["10:00"]}' });
  });

  it('maps refusals and truncation', async () => {
    script = [{ kind: 'refusal', text: 'I cannot help with that.' }, { kind: 'incomplete', text: 'Cut off' }];
    expect((await provider().generate(baseRequest)).stopReason).toBe('refusal');
    expect((await provider().generate(baseRequest)).stopReason).toBe('max_tokens');
  });

  it('classifies errors: quota is billing (no retry), rate limit retries, bad key is auth', async () => {
    const run = async (status: number, body: unknown) => {
      script = [{ kind: 'error', status, body }];
      return provider().generate(baseRequest).catch((e) => e);
    };
    expect(await run(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } })).toMatchObject({ kind: 'billing', retryable: false });
    expect(await run(429, { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } })).toMatchObject({ kind: 'rate_limit', retryable: true });
    const auth = await run(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
    expect(auth).toBeInstanceOf(LlmError);
    expect(auth).toMatchObject({ kind: 'auth', retryable: false, provider: 'openai' });
  });

  it('drops the encrypted-reasoning include for models that reject it, once', async () => {
    requests.length = 0;
    script = [
      { kind: 'error', status: 400, body: { error: { message: 'include not supported for this model', type: 'invalid_request_error', param: 'include' } } },
      { kind: 'text', text: 'ok' },
      { kind: 'text', text: 'ok again' },
    ];
    const p = provider({ model: 'plain-model' });
    expect((await p.generate(baseRequest)).content).toEqual([{ type: 'text', text: 'ok' }]);
    await p.generate(baseRequest);
    expect(requests.map((r) => Boolean(r.include))).toEqual([true, false, false]);
  });

  it('verify() checks the key and the configured models', async () => {
    expect(await provider().verify()).toMatchObject({ ok: true });
    expect(await provider({ model: 'missing-model' }).verify()).toMatchObject({ ok: false });
  });
});

describe('orchestrator on the OpenAI provider', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('runs a real tool loop: capture details, then answer', async () => {
    const org = await createOrg(t.c);
    // Swap in the OpenAI provider for this org's run (same container, same tools and DB).
    (t.c.orchestrator as unknown as { deps: { llm: unknown } }).deps.llm = provider();
    requests.length = 0;
    script = [
      { kind: 'tools', reasoning: true, calls: [{ name: 'save_contact_details', args: { name: 'Mina Park', email: 'mina@example.com' } }] },
      { kind: 'text', text: 'Thanks Mina, I saved your details.' },
    ];
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'oa', content: "I'm Mina Park, mina@example.com" });
    await t.c.queue.drain();
    const contact = await t.c.contacts.get(org.scope, r.contactId);
    expect(contact).toMatchObject({ name: 'Mina Park', email: 'mina@example.com' });
    const msgs = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(msgs.at(-1)!.content).toBe('Thanks Mina, I saved your details.');
    // Round 2 carried the tool output back with the same call id.
    const second = requests[1]!.input as Array<Record<string, unknown>>;
    const output = second.find((i) => i.type === 'function_call_output')!;
    expect(JSON.parse(String(output.output))).toMatchObject({ saved: expect.arrayContaining(['email']) });
    expect(requests[0]!.instructions).toContain('You are Ava');
  });
});
