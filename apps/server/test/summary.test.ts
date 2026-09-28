import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/client';
import { verifyWebhookSignature } from '../src/lib/crypto';
import type { MockTurn } from '../src/modules/ai/llm/mock';
import type { LlmMessage, LlmRequest } from '../src/modules/ai/llm/types';
import { convChannel } from '../src/modules/conversations/service';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/**
 * F3 — Conversation summary. Recaps come with parts (what the customer wants, the outcome, the next step, their
 * mood), are written at handoff and on request as well as after a quiet spell and on close, go out as a webhook,
 * and never reach the visitor's browser. The AI's memory keeps using the summary text as before.
 */

let t: TestEnv;
let baseUrl: string;
beforeAll(async () => {
  t = await createTestEnv();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;

const RECAP = {
  summary: 'The customer asked about teeth whitening ($450) and says a friend was given a discount.',
  intent: 'Teeth whitening, ideally at a discount.',
  outcome: 'Given the price; no discount offered.',
  nextStep: 'The team decides whether to offer a discount.',
  sentiment: 'neutral',
};

/** Summary calls answer with `recap(n, req)`; every other call plays `turns` in order (then "ok"). */
function script(turns: MockTurn[], recap: (n: number, req: LlmRequest) => string = () => JSON.stringify(RECAP)) {
  const queue = [...turns];
  let n = 0;
  t.llm.setScript(
    Array.from({ length: 300 }, () => (req: LlmRequest, call: number, opts) => {
      if (req.tier === 'utility') return text(recap(++n, req))();
      const next = queue.shift();
      return next ? next(req, call, opts) : text('ok')();
    }),
  );
}

const summaryCalls = () => t.llm.requests.filter((r) => r.tier === 'utility');
const textOf = (messages: LlmMessage[]) => messages.flatMap((m) => m.content.map((b) => (b.type === 'text' ? b.text : ''))).join('\n');

async function send(org: Org, visitor: string, content: string) {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

async function convRow(id: string) {
  const [row] = await t.c.db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
  return row!;
}

async function lastMessageId(conversationId: string) {
  const all = await t.c.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
  return all.at(-1)!.id;
}

async function summarizedEvents(conversationId: string) {
  return t.c.db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.conversationId, conversationId), eq(schema.events.type, 'conversation.summarized' as never)));
}

const setStatus = (org: Org, conversationId: string, action: 'takeover' | 'resume' | 'close', reason?: string) =>
  t.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/status`, headers: authHeaders(org.token), payload: { action, ...(reason ? { reason } : {}) } });

describe('a recap at handoff', () => {
  it('the AI handing off, by keyword or by tool, and staff taking over each get a recap straight away', async () => {
    const org = await createOrg(t.c, 'Handoff Clinic');

    // By keyword: no model reply, only the handoff message; the recap covers it too.
    script([text('Whitening is $450.')]);
    await send(org, 'kw', 'How much is whitening?');
    const kw = await send(org, 'kw', 'Can I talk to a human please?');
    const byKeyword = await convRow(kw.conversationId);
    expect(byKeyword.status).toBe('human_active');
    expect(byKeyword.summary).toBe(RECAP.summary);
    expect(byKeyword.summaryDetails).toMatchObject({
      intent: RECAP.intent,
      outcome: RECAP.outcome,
      nextStep: RECAP.nextStep,
      sentiment: 'neutral',
      trigger: 'handoff',
      throughMessageId: await lastMessageId(kw.conversationId),
    });
    expect(byKeyword.summarizedThroughMessageId).toBe(await lastMessageId(kw.conversationId));

    // By tool: the recap is told why the AI handed off.
    script([text('Whitening is $450.'), tools({ name: 'transfer_to_human', input: { reason: 'Wants a discount the AI cannot give' } }), text('Connecting you with the team.')]);
    await send(org, 'tool', 'How much is whitening?');
    const tool = await send(org, 'tool', 'My friend got a discount, can I have one too?');
    expect((await convRow(tool.conversationId)).summaryDetails).toMatchObject({ trigger: 'handoff' });
    expect(summaryCalls()).toHaveLength(1);
    expect(textOf(summaryCalls()[0]!.messages)).toContain('Wants a discount the AI cannot give');

    // Staff taking over; the open conversation page hears about the new summary (the event carries no content).
    script([text('Sure.'), text('Of course.')]);
    await send(org, 'staff', 'Do you do Invisalign?');
    const staff = await send(org, 'staff', 'How long does it take?');
    const live: unknown[] = [];
    const unsubscribe = t.c.pubsub.subscribe(convChannel(staff.conversationId), (e) => live.push(e));
    expect((await setStatus(org, staff.conversationId, 'takeover')).statusCode).toBe(200);
    await t.c.queue.drain();
    unsubscribe();
    expect((await convRow(staff.conversationId)).summaryDetails).toMatchObject({ trigger: 'handoff', intent: RECAP.intent });
    expect(live).toContainEqual({ type: 'conversation.summary', conversationId: staff.conversationId });
  });

  it('none with the AI off, a spent budget, or a one-message chat', async () => {
    script([text('Sure.'), text('Of course.')], () => 'SHOULD NOT HAPPEN');
    const single = await createOrg(t.c, 'Single Handoff');
    const one = await send(single, 'one', 'Can I talk to a human please?');
    expect((await convRow(one.conversationId)).status).toBe('human_active');

    const off = await createOrg(t.c, 'Off Handoff');
    await send(off, 'off', 'First question');
    const offConv = await send(off, 'off', 'Second question');
    await t.c.tenancy.updateOrganization(off.orgId, { aiEnabled: false });
    await setStatus(off, offConv.conversationId, 'takeover');

    const spent = await createOrg(t.c, 'Spent Handoff');
    await send(spent, 'spent', 'First question');
    const spentConv = await send(spent, 'spent', 'Second question');
    await t.c.tenancy.updateOrganization(spent.orgId, { monthlyAiBudgetUsd: 0.000001 });
    await setStatus(spent, spentConv.conversationId, 'takeover');

    await t.c.queue.drain();
    expect(summaryCalls()).toHaveLength(0);
  });
});

describe('recaps with parts', () => {
  const close = async (org: Org, conversationId: string) => {
    await setStatus(org, conversationId, 'close');
    await t.c.queue.drain();
  };

  it('keep the summary text and its parts; a code fence is fine, a plain answer is kept without parts', async () => {
    const org = await createOrg(t.c, 'Parts Clinic');
    script([text('Sure.'), text('Of course.')], () => '```json\n' + JSON.stringify({ ...RECAP, outcome: 'x'.repeat(1000), sentiment: 'ecstatic' }) + '\n```');
    await send(org, 'fence', 'Do you do whitening?');
    const fenced = await send(org, 'fence', 'How much is it?');
    await close(org, fenced.conversationId);
    const a = await convRow(fenced.conversationId);
    expect(a.summary).toBe(RECAP.summary);
    expect(a.summaryDetails).toMatchObject({ intent: RECAP.intent, nextStep: RECAP.nextStep, sentiment: null, trigger: 'closed' });
    expect(a.summaryDetails!.outcome!.length).toBeLessThanOrEqual(300);
    // Nothing open: the next step is empty.
    script([text('Sure.'), text('Of course.')], () => JSON.stringify({ ...RECAP, nextStep: '' }));
    await send(org, 'done', 'Are you open Saturday?');
    const done = await send(org, 'done', 'Great, thanks');
    await close(org, done.conversationId);
    expect((await convRow(done.conversationId)).summaryDetails).toMatchObject({ nextStep: null });

    // JSON without the summary itself: nothing is saved (never raw JSON as the AI's memory).
    script([text('Sure.'), text('Of course.')], () => JSON.stringify({ intent: RECAP.intent, sentiment: 'neutral' }));
    await send(org, 'nosummary', 'Do you do whitening?');
    const noSummary = await send(org, 'nosummary', 'How much is it?');
    await close(org, noSummary.conversationId);
    expect(await convRow(noSummary.conversationId)).toMatchObject({ summary: null, summaryDetails: null });

    script([text('Sure.'), text('Of course.')], () => 'The customer asked about whitening.');
    await send(org, 'plain', 'Do you do whitening?');
    const plain = await send(org, 'plain', 'How much is it?');
    await close(org, plain.conversationId);
    const b = await convRow(plain.conversationId);
    expect(b.summary).toBe('The customer asked about whitening.');
    expect(b.summaryDetails).toMatchObject({ intent: null, outcome: null, nextStep: null, sentiment: null, trigger: 'closed' });
  });

  it("the AI's memory gets the summary text, not the parts", async () => {
    const org = await createOrg(t.c, 'Memory Parts');
    script([text('Sure.'), text('Of course.'), text('Welcome back!')]);
    await send(org, 'mem', 'Do you do whitening?');
    const a = await send(org, 'mem', 'How much is it?');
    await setStatus(org, a.conversationId, 'takeover');
    await t.c.queue.drain();
    await setStatus(org, a.conversationId, 'resume');
    await send(org, 'mem', 'Back again, any news?');
    const reply = t.llm.requests.filter((r) => r.tier !== 'utility').at(-1)!;
    const memory = textOf(reply.messages).match(/<earlier_in_this_conversation>[\s\S]*?<\/earlier_in_this_conversation>/)?.[0] ?? '';
    expect(memory).toContain(RECAP.summary);
    expect(textOf(reply.messages)).not.toContain(RECAP.nextStep);
    expect(textOf(reply.messages)).not.toContain('"intent"');
  });

  it('folds of long chats keep their plain summary, leave the parts alone and send no event', async () => {
    const org = await createOrg(t.c, 'Fold Parts');
    // Recaps ask for JSON; folds keep today's instructions and plain answer.
    script([], (_n, req) => (req.system.includes('JSON') ? JSON.stringify(RECAP) : 'FOLDED SUMMARY'));
    await send(org, 'fold', 'Do you do whitening?');
    const a = await send(org, 'fold', 'How much is it?');
    await setStatus(org, a.conversationId, 'takeover');
    await t.c.queue.drain();
    await setStatus(org, a.conversationId, 'resume');
    const recap = (await convRow(a.conversationId)).summaryDetails;
    expect(recap).toMatchObject({ trigger: 'handoff' });
    for (let k = 1; k <= 17; k++) await send(org, 'fold', `question ${k}`);

    const folds = summaryCalls().filter((r) => !r.system.includes('JSON'));
    expect(folds.length).toBeGreaterThanOrEqual(1);
    const row = await convRow(a.conversationId);
    expect(row.summary).toBe('FOLDED SUMMARY');
    expect(row.summaryDetails).toEqual(recap);
    expect(await summarizedEvents(a.conversationId)).toHaveLength(1);
  });

  it('an older, slower recap never overwrites a newer one, parts included', async () => {
    const org = await createOrg(t.c, 'Stale Parts');
    script([text('r1'), text('r2')]);
    await send(org, 'stale', 'one');
    const a = await send(org, 'stale', 'two');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.llm.setScript([
      async () => {
        await gate;
        return text(JSON.stringify({ ...RECAP, intent: 'OLD' }))();
      },
      text(JSON.stringify({ ...RECAP, intent: 'NEW' })),
    ]);
    const slow = t.c.summarizer.run({ orgId: org.orgId, conversationId: a.conversationId, mode: 'recap', trigger: 'manual' });
    await vi.waitFor(() => expect(t.llm.requests).toHaveLength(1));
    await t.c.summarizer.run({ orgId: org.orgId, conversationId: a.conversationId, mode: 'recap', trigger: 'manual' });
    release();
    await slow;
    expect((await convRow(a.conversationId)).summaryDetails).toMatchObject({ intent: 'NEW' });
    expect(await summarizedEvents(a.conversationId)).toHaveLength(1);
  });
});

describe('webhooks', () => {
  let receiver: Server;
  let receiverUrl: string;
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => receiver.close(() => r())));

  it('each recap goes out as conversation.summarized, signed; test conversations never do', async () => {
    const org = await createOrg(t.c, 'Webhook Clinic');
    const h = authHeaders(org.token);
    const ep = await t.app.inject({ method: 'POST', url: '/v1/webhooks', headers: h, payload: { name: 'crm', url: `${receiverUrl}/hook`, eventTypes: ['conversation.summarized'] } });
    expect(ep.statusCode).toBe(201);
    const { secret } = ep.json() as { secret: string };

    script([text('Sure.'), text('Of course.')]);
    await send(org, 'hook', 'Do you do whitening?');
    const a = await send(org, 'hook', 'How much is it?');
    await setStatus(org, a.conversationId, 'close');
    await t.c.queue.drain();
    await t.c.automation.dispatchPending();
    await t.c.queue.drain();

    expect(received).toHaveLength(1);
    const delivery = received[0]!;
    expect(delivery.headers['x-omni-event']).toBe('conversation.summarized');
    expect(verifyWebhookSignature(secret, delivery.body, String(delivery.headers['x-omni-signature']))).toBe(true);
    expect(JSON.parse(delivery.body)).toMatchObject({
      type: 'conversation.summarized',
      data: { ...RECAP, trigger: 'closed', status: 'closed', conversation_id: a.conversationId, contact: { id: a.contactId } },
    });
    // It's on the conversation's timeline too.
    const timeline = await t.app.inject({ method: 'GET', url: `/v1/conversations/${a.conversationId}/timeline`, headers: h });
    expect(timeline.json().events.map((e: { type: string }) => e.type)).toContain('conversation.summarized');

    // A playground conversation's recap is recorded but never sent.
    const pg = (await t.app.inject({ method: 'POST', url: `/v1/bots/${org.bot.id}/playground`, headers: h })).json() as { token: string };
    let pgConversation = '';
    for (const content of ['Do you do whitening?', 'How much is it?']) {
      const res = await t.app.inject({ method: 'POST', url: '/widget/v1/messages', headers: { authorization: `Bearer ${pg.token}` }, payload: { content } });
      pgConversation = res.json().conversationId;
      await t.c.queue.drain();
    }
    await setStatus(org, pgConversation, 'close');
    await t.c.queue.drain();
    await t.c.automation.dispatchPending();
    await t.c.queue.drain();
    expect(await summarizedEvents(pgConversation)).toHaveLength(1);
    expect(received).toHaveLength(1);
  });
});

describe('refresh', () => {
  it('agents can ask for a new summary; nothing new means no model call; viewers and API keys cannot', async () => {
    const org = await createOrg(t.c, 'Refresh Clinic');
    const h = authHeaders(org.token);
    script([text('Sure.'), text('Of course.')]);
    await send(org, 'ref', 'Do you do whitening?');
    const a = await send(org, 'ref', 'How much is it?');
    const url = `/v1/conversations/${a.conversationId}/summary`;

    const first = await t.app.inject({ method: 'POST', url, headers: h });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ queued: true });
    await t.c.queue.drain();
    expect((await convRow(a.conversationId)).summaryDetails).toMatchObject({ trigger: 'manual', intent: RECAP.intent });
    expect(summaryCalls()).toHaveLength(1);

    const again = await t.app.inject({ method: 'POST', url, headers: h });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ queued: false, reason: 'nothing_new' });
    await t.c.queue.drain();
    expect(summaryCalls()).toHaveLength(1);

    const single = await send(org, 'single', 'Hi there');
    const short = await t.app.inject({ method: 'POST', url: `/v1/conversations/${single.conversationId}/summary`, headers: h });
    expect(short.json()).toEqual({ queued: false, reason: 'too_short' });

    const email = `viewer-${Date.now()}@example.com`;
    await t.app.inject({ method: 'POST', url: '/v1/members', headers: h, payload: { email, role: 'viewer', password: 'member-password-1' } });
    const login = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'member-password-1' } });
    expect((await t.app.inject({ method: 'POST', url, headers: authHeaders(login.json().token) })).statusCode).toBe(403);
    const key = (await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: h, payload: { name: 'crm', scopes: ['conversations:write'] } })).json().key as string;
    expect((await t.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
  });
});

describe('language', () => {
  it("writes in English, or in the bot's language when it has a fixed one", async () => {
    const org = await createOrg(t.c, 'Language Clinic');
    script([text('Sure.'), text('Of course.'), text('Claro.'), text('Por supuesto.')]);
    await send(org, 'en', 'Do you do whitening?');
    const en = await send(org, 'en', 'How much is it?');
    await setStatus(org, en.conversationId, 'close');
    await t.c.queue.drain();
    expect(summaryCalls().at(-1)!.system).toContain('in English, whatever language the conversation is in');

    await t.c.bots.update(org.scope, org.bot.id, { config: { persona: { ...org.bot.config.persona, language: 'Spanish' } } });
    await send(org, 'es', '¿Hacen blanqueamiento?');
    const es = await send(org, 'es', '¿Cuánto cuesta?');
    await setStatus(org, es.conversationId, 'close');
    await t.c.queue.drain();
    expect(summaryCalls().at(-1)!.system).toContain('in Spanish, whatever language the conversation is in');
  });
});

describe("the visitor's browser", () => {
  it('gets messages, typing and status, but never the handoff reason or the summary', async () => {
    const org = await createOrg(t.c, 'Stream Clinic');
    const session = (await t.app.inject({ method: 'POST', url: '/widget/v1/sessions', payload: { key: org.webchat.publicKey } })).json() as { token: string };
    const auth = { authorization: `Bearer ${session.token}` };
    script([text('Sure.'), text('Of course.')]);
    let conversationId = '';
    for (const content of ['Do you do whitening?', 'How much is it?']) {
      conversationId = (await t.app.inject({ method: 'POST', url: '/widget/v1/messages', headers: auth, payload: { content } })).json().conversationId;
      await t.c.queue.drain();
    }
    const stream = await fetch(`${baseUrl}/widget/v1/stream?conversationId=${conversationId}`, { headers: auth });
    expect(stream.status).toBe(200);

    await setStatus(org, conversationId, 'takeover', 'VIP: the owner handles this one personally');
    await t.c.queue.drain(); // the recap runs and announces itself on the conversation's channel
    expect((await convRow(conversationId)).summaryDetails).toMatchObject({ trigger: 'handoff' });
    await t.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/messages`, headers: authHeaders(org.token), payload: { content: 'Hi, Sam from the team here.' } });

    const events = await readSse(stream, (e, d) => e === 'message' && d.message.role === 'agent');
    expect(events.find((e) => e.event === 'conversation.status')?.data).toEqual({ type: 'conversation.status', conversationId, status: 'human_active' });
    expect(events.map((e) => e.event)).not.toContain('conversation.summary');
    expect(JSON.stringify(events)).not.toContain('VIP');
  });
});

/** Reads an SSE response until `until` returns true for an event (or the time runs out). */
async function readSse(res: Response, until: (event: string, data: any) => boolean, timeoutMs = 10_000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (!event || !data) continue;
      const parsed = { event, data: JSON.parse(data) };
      events.push(parsed);
      if (until(parsed.event, parsed.data)) {
        await reader.cancel();
        return events;
      }
    }
  }
  await reader.cancel();
  return events;
}
