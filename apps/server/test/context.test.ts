import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import type { LlmMessage } from '../src/modules/ai/llm/types';
import { parseLocalStart } from '../src/modules/scheduling/availability';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

/**
 * F2 — Conversation context: the greeting the visitor answered, the page they're on, what the team knows (facts
 * staff add or remove, notes they choose to share), the customer's standing and their recent appointments.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

const START = new Date('2026-09-28T13:00:00Z'); // Monday 09:00 in Toronto
afterEach(() => {
  t.now.value = START;
});

type Org = Awaited<ReturnType<typeof createOrg>>;
const ORIGIN = 'https://context.example';

/** A widget visitor. `send` posts a message (optionally from a page) and returns the model's request. */
async function widget(org: Org) {
  const session = await t.app.inject({ method: 'POST', url: '/widget/v1/sessions', headers: { origin: ORIGIN }, payload: { key: org.webchat.publicKey } });
  const token = (session.json() as { token: string }).token;
  let conversationId = '';
  const send = async (content: string, pageUrl?: string) => {
    t.llm.setScript([text('ok')]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/widget/v1/messages',
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      payload: { content, ...(pageUrl ? { pageUrl } : {}) },
    });
    expect(res.statusCode).toBeLessThan(300);
    conversationId = (res.json() as { conversationId: string }).conversationId;
    await t.c.queue.drain();
    return t.llm.requests.at(-1)!;
  };
  return {
    send,
    conversationId: () => conversationId,
    contactId: async () => (await t.c.conversations.get(org.scope, conversationId)).contactId,
  };
}

/** Everything the model was sent, in order. */
const allText = (messages: LlmMessage[]) => messages.flatMap((m) => m.content.map((b) => ('text' in b ? b.text : ''))).join('\n');
/** The context block of the newest turn. */
const latestContext = (messages: LlmMessage[]) => {
  const all = allText(messages);
  return all.slice(all.lastIndexOf('<context>'));
};

const setGreeting = (org: Org, greeting: string) =>
  t.app.inject({
    method: 'PATCH',
    url: `/v1/bots/${org.bot.id}`,
    headers: authHeaders(org.token),
    payload: { config: { persona: { ...org.bot.config.persona, greeting } } },
  });

describe('the greeting the visitor saw', () => {
  it('comes before their first reply, as the widget shows it', async () => {
    const org = await createOrg(t.c, 'Greeting Clinic');
    await setGreeting(org, 'Hi! Want 20% off teeth whitening this month?');
    const visitor = await widget(org);
    expect(allText((await visitor.send('yes please!')).messages)).toMatch(/Want 20% off teeth whitening this month\?[\s\S]*yes please!/);

    // A greeting set on the widget itself wins, exactly as in the widget.
    await t.app.inject({ method: 'PATCH', url: `/v1/channels/${org.webchat.id}`, headers: authHeaders(org.token), payload: { config: { greeting: 'Welcome to our spa!' } } });
    const other = await widget(org);
    expect(allText((await other.send('hello')).messages)).toMatch(/Welcome to our spa![\s\S]*hello/);
  });

  it('is left out for API conversations, and once the first message is folded into the summary', async () => {
    const org = await createOrg(t.c, 'Fold Clinic');
    await setGreeting(org, 'Hi! Want a free consultation?');
    const api = await t.c.channels.ensureSystemChannel(org.orgId, 'api');
    t.llm.setScript([text('ok')]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: api.id, externalUserId: 'api-1', content: 'yes' });
    await t.c.queue.drain();
    const viaApi = t.llm.requests.at(-1)!.messages;
    expect(allText(viaApi)).not.toContain('free consultation');
    expect(latestContext(viaApi)).not.toContain('<page>');

    const visitor = await widget(org);
    expect(allText((await visitor.send('yes')).messages)).toContain('Hi! Want a free consultation?');
    // The conversation grew and its first messages were folded into the summary.
    const [first] = await t.c.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, visitor.conversationId()))
      .orderBy(asc(schema.messages.createdAt))
      .limit(1);
    await t.c.db
      .update(schema.conversations)
      .set({ summary: 'The customer accepted the consultation offer.', summarizedThroughMessageId: first!.id })
      .where(eq(schema.conversations.id, visitor.conversationId()));
    expect(allText((await visitor.send('when can I come?')).messages)).not.toContain('Hi! Want a free consultation?');
  });
});

describe('the page', () => {
  it("shows the page of the visitor's latest message, without other query parameters", async () => {
    const org = await createOrg(t.c, 'Page Clinic');
    const visitor = await widget(org);
    const first = await visitor.send('how much is it?', `${ORIGIN}/invisalign?utm_source=google&email=ana@example.com`);
    expect(latestContext(first.messages)).toContain(`<page>${ORIGIN}/invisalign?utm_source=google</page>`);
    expect(allText(first.messages)).not.toContain('email=');

    const second = await visitor.send('and this one?', `${ORIGIN}/implants`);
    expect(latestContext(second.messages)).toContain(`<page>${ORIGIN}/implants</page>`);
    expect(latestContext(second.messages)).not.toContain('/invisalign');
  });
});

describe('what the AI remembers', () => {
  it("puts the team's facts first, and a wrong fact can be removed, even one saved before facts had IDs", async () => {
    const org = await createOrg(t.c, 'Memory Clinic');
    const visitor = await widget(org);
    await visitor.send('hi');
    const contactId = await visitor.contactId();
    await t.c.contacts.addNote(org.scope, contactId, 'Prefers evening appointments.', 'ai');
    const [row] = await t.c.db.select({ memory: schema.contacts.memory }).from(schema.contacts).where(eq(schema.contacts.id, contactId));
    await t.c.db
      .update(schema.contacts)
      .set({ memory: [{ text: 'Has two kids.', source: 'ai', createdAt: '2026-09-01T10:00:00.000Z' }, ...row!.memory] })
      .where(eq(schema.contacts.id, contactId));

    const h = authHeaders(org.token);
    const added = await t.app.inject({ method: 'POST', url: `/v1/contacts/${contactId}/memory`, headers: h, payload: { text: 'Allergic to latex.' } });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ id: expect.any(String), text: 'Allergic to latex.', source: 'user' });

    const req = await visitor.send('can I book a cleaning?');
    expect(latestContext(req.messages)).toMatch(/remembered:\n- \(noted by the team\) Allergic to latex\.\n- Has two kids\.\n- Prefers evening appointments\./);
    expect(req.system).toContain('notes from the team');

    const memory = (await t.app.inject({ method: 'GET', url: `/v1/contacts/${contactId}`, headers: h })).json().memory as Array<{ id: string; text: string }>;
    const legacy = memory.find((m) => m.text === 'Has two kids.')!;
    expect(legacy.id).toEqual(expect.any(String));
    expect((await t.app.inject({ method: 'DELETE', url: `/v1/contacts/${contactId}/memory/${legacy.id}`, headers: h })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: `/v1/contacts/${contactId}/memory/${legacy.id}`, headers: h })).statusCode).toBe(404);
    expect(latestContext((await visitor.send('thanks')).messages)).not.toContain('Has two kids');
  });

  it("a viewer can't change it; an API key with contacts:write can; long facts are refused", async () => {
    const org = await createOrg(t.c, 'Access Clinic');
    const visitor = await widget(org);
    await visitor.send('hi');
    const contactId = await visitor.contactId();
    const owner = authHeaders(org.token);
    const email = `viewer-${Date.now()}@example.com`;
    await t.app.inject({ method: 'POST', url: '/v1/members', headers: owner, payload: { email, role: 'viewer', password: 'member-password-1' } });
    const login = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'member-password-1' } });
    const viewer = authHeaders((login.json() as { token: string }).token);
    const memoryUrl = `/v1/contacts/${contactId}/memory`;
    expect((await t.app.inject({ method: 'POST', url: memoryUrl, headers: viewer, payload: { text: 'Likes coffee.' } })).statusCode).toBe(403);

    const key = (await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: owner, payload: { name: 'crm', scopes: ['contacts:write'] } })).json().key as string;
    const viaKey = await t.app.inject({ method: 'POST', url: memoryUrl, headers: { authorization: `Bearer ${key}` }, payload: { text: 'VIP: offer the first free slot.' } });
    expect(viaKey.statusCode).toBe(201);
    expect((await t.app.inject({ method: 'DELETE', url: `${memoryUrl}/${viaKey.json().id}`, headers: viewer })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: memoryUrl, headers: owner, payload: { text: 'z'.repeat(501) } })).statusCode).toBe(400);
  });

  it('a note shared with the assistant becomes a team fact; other notes stay internal', async () => {
    const org = await createOrg(t.c, 'Notes Clinic');
    const visitor = await widget(org);
    await visitor.send('hi');
    const contactId = await visitor.contactId();
    const h = authHeaders(org.token);
    const notes = `/v1/contacts/${contactId}/notes`;
    expect((await t.app.inject({ method: 'POST', url: notes, headers: h, payload: { body: 'Interested in the premium whitening package.', shareWithAssistant: true } })).statusCode).toBe(201);
    expect((await t.app.inject({ method: 'POST', url: notes, headers: h, payload: { body: 'Owes $200 from the last visit.' } })).statusCode).toBe(201);
    const ctx = latestContext((await visitor.send('any news?')).messages);
    expect(ctx).toContain('- (noted by the team) Interested in the premium whitening package.');
    expect(ctx).not.toContain('Owes $200');
  });
});

describe('standing and history', () => {
  it('shows the lifecycle stage and the last 3 past appointments with their outcomes, even with booking off', async () => {
    const org = await createOrg(t.c, 'History Clinic'); // booking is off on a new organization's bot
    const visitor = await widget(org);
    await visitor.send('hi');
    const contactId = await visitor.contactId();
    await t.app.inject({ method: 'PATCH', url: `/v1/contacts/${contactId}`, headers: authHeaders(org.token), payload: { lifecycleStage: 'customer' } });

    const book = (local: string, title: string) =>
      t.c.scheduling.book(org.scope, {
        calendarId: org.calendar.id,
        contactId,
        start: parseLocalStart(local, 'America/Toronto')!,
        title,
        createdBy: 'user',
        notifyCustomer: false,
      });
    await book('2026-09-29T10:00', 'Checkup'); // the fourth most recent: left out
    const cleaning = await book('2026-09-29T11:00', 'Cleaning');
    const whitening = await book('2026-09-29T12:00', 'Whitening');
    const consultation = await book('2026-09-30T10:00', 'Consultation');
    await t.c.db.insert(schema.appointments).values({
      organizationId: org.orgId,
      calendarId: org.calendar.id,
      contactId,
      title: 'Old visit',
      startsAt: new Date('2025-08-04T14:00:00Z'),
      endsAt: new Date('2025-08-04T14:30:00Z'),
      timezone: 'America/Toronto',
      status: 'completed',
    });
    t.now.value = new Date('2026-10-05T13:00:00Z');
    await t.c.scheduling.setStatus(org.scope, cleaning.appointment.id, 'completed');
    await t.c.scheduling.setStatus(org.scope, whitening.appointment.id, 'no_show');
    await t.c.scheduling.cancel(org.scope, consultation.appointment.id, { actor: 'user', notifyCustomer: false });

    const ctx = latestContext((await visitor.send('hello again')).messages);
    expect(ctx).toContain('stage: customer');
    expect(ctx).toContain(
      [
        '- Consultation: Wed 30 Sep 2026, 10:00 AM (America/Toronto), cancelled',
        '- Whitening: Tue 29 Sep 2026, 12:00 PM (America/Toronto), no-show',
        '- Cleaning: Tue 29 Sep 2026, 11:00 AM (America/Toronto), completed',
      ].join('\n'),
    );
    expect(ctx).not.toContain('Checkup');
    expect(ctx).not.toContain('Old visit');
  });
});
