import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { createOrg, text, tools } from '../test/helpers';
import { createIntegrationEnv, enabled, eventually, flushRedis, type IntegrationEnv } from './helpers';

/**
 * Human Handover, Stop Bot and Advanced Booking on a real Postgres (row locks, RLS) and Redis (BullMQ workers, the
 * conversation lock): the races the in-memory suite can't show, and a full turn through the real queue.
 */

const tuesday = () => {
  let d = DateTime.now().setZone('America/Toronto').plus({ days: 8 }).startOf('day');
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  return `${d.toFormat('yyyy-MM-dd')}T10:00`;
};

describe.skipIf(!enabled)('handover, stop and booking on Postgres and Redis', () => {
  let t: IntegrationEnv;
  beforeAll(async () => {
    await flushRedis();
    t = await createIntegrationEnv({ now: new Date(), workers: true });
  });
  afterAll(async () => t?.close());

  const convRow = async (orgId: string, id: string) => (await t.c.tenantDb.run(orgId, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, id))))[0]!;
  const aiSays = async (org: Awaited<ReturnType<typeof createOrg>>, id: string) => (await t.c.conversations.messages(org.scope, id)).filter((m) => m.senderType === 'ai').map((m) => m.content);
  const eventsOf = async (org: Awaited<ReturnType<typeof createOrg>>, contactId: string) => (await t.c.automation.listEvents(org.scope, { contactId })).map((e) => e.type);

  async function started(name: string) {
    const org = await createOrg(t.c, name);
    t.llm.setScript([text('Hello!')]);
    const first = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: `v-${name}`, content: 'hi' });
    await eventually(async () => expect(await aiSays(org, first.conversationId)).toHaveLength(1));
    return { org, ...first };
  }

  it('many simultaneous stops record one stop and one event', async () => {
    const { org, conversationId, contactId } = await started('IT Stop Race');
    const results = await Promise.all(Array.from({ length: 10 }, () => t.c.conversations.stopBot(org.scope, conversationId, { scenarioId: 'x', scenarioName: 'Bye', until: null, tags: [] })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await eventsOf(org, contactId)).filter((e) => e === 'conversation.bot_stopped')).toHaveLength(1);
  });

  it('a stop and a handover at the same moment never leave a stop on a conversation the team has', async () => {
    for (let i = 0; i < 5; i++) {
      const { org, conversationId } = await started(`IT Stop vs Handover ${i}`);
      await Promise.all([
        t.c.conversations.stopBot(org.scope, conversationId, { scenarioId: 'x', scenarioName: 'Bye', until: null, tags: [] }),
        t.c.conversations.setStatus(org.scope, conversationId, 'human_active', { actor: 'ai', reason: 'test', notifyTeam: true, onlyFrom: ['ai_active'] }),
      ]);
      const row = await convRow(org.orgId, conversationId);
      if (row.status === 'human_active') expect(row.metadata).not.toHaveProperty('aiStop');
    }
  });

  it('simultaneous handovers (two turns, a staff takeover) make one handover', async () => {
    const { org, conversationId, contactId } = await started('IT Handover Race');
    await Promise.all([
      t.c.conversations.setStatus(org.scope, conversationId, 'human_active', { actor: 'ai', reason: 'a', notifyTeam: true, onlyFrom: ['ai_active'] }),
      t.c.conversations.setStatus(org.scope, conversationId, 'human_active', { actor: 'ai', reason: 'b', notifyTeam: true, onlyFrom: ['ai_active'] }),
      t.c.conversations.setStatus(org.scope, conversationId, 'human_active', { actor: 'ai', reason: 'c', notifyTeam: true, onlyFrom: ['ai_active'] }),
    ]);
    expect((await eventsOf(org, contactId)).filter((e) => e === 'conversation.handoff_requested')).toHaveLength(1);
  });

  it('through the real queue: a trigger phrase hands over once, and the customer then gets no AI reply', async () => {
    const org = await createOrg(t.c, 'IT Trigger');
    const send = (content: string) => t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'it-trigger', content });
    t.llm.setScript([text('Hello!')]);
    const first = await send('hello');
    await eventually(async () => expect(await aiSays(org, first.conversationId)).toHaveLength(1));
    t.llm.setScript([text('should not be sent')]);
    await send('can I talk to a human please');
    await eventually(async () => expect((await convRow(org.orgId, first.conversationId)).status).toBe('human_active'));
    await send('hello??');
    await new Promise((r) => setTimeout(r, 500));
    expect(await aiSays(org, first.conversationId)).toHaveLength(2);
  });

  it('through the real queue: a booking with pause, transfer and a workflow-free follow-up ends with the bot quiet and the member assigned', async () => {
    const org = await createOrg(t.c, 'IT Booking');
    const member = await t.c.tenancy.addMember(org.orgId, { email: `jo-${Date.now()}@example.com`, role: 'agent', password: 'password-123', name: 'Jo' });
    await t.c.bots.update(org.scope, org.bot.id, {
      config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'], pauseAfterBooking: true, transferEmployee: true, transferUserId: member.userId } },
    });
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Sam' } }, { name: 'book_appointment', input: { start: tuesday(), customer_confirmed: true } }), text('Booked, see you then!')]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'it-book', content: 'Sam, Tuesday 10am please' });
    await eventually(async () => expect(await aiSays(org, r.conversationId)).toEqual(['Booked, see you then!']));
    const row = await convRow(org.orgId, r.conversationId);
    expect(row.status).toBe('ai_active');
    expect(row.assignedUserId).toBe(member.userId);
    expect(row.metadata).toMatchObject({ aiStop: { scenarioName: 'Appointment booked', until: null } });
    expect((await t.c.scheduling.listForContact(org.scope, r.contactId)).filter((a) => a.status === 'booked')).toHaveLength(1);

    t.llm.setScript([text('should not be sent')]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'it-book', content: 'thanks!' });
    await new Promise((r) => setTimeout(r, 500));
    expect(await aiSays(org, r.conversationId)).toHaveLength(1);
  });
});
