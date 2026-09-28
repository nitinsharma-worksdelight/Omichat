import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

async function botWithEverything() {
  const org = await createOrg(t.c, 'Acme Clinic');
  await t.c.contacts.createTag(org.scope, { name: 'invisalign' });
  await t.c.knowledge.createFaqDocument(org.scope, org.kb.id, {
    title: 'FAQ',
    category: 'faq',
    faq: [{ question: 'How much is Invisalign?', answer: 'Invisalign costs $3,500 to $6,500. Consultations are free.' }],
  });
  await t.c.queue.drain();
  const bot = await t.c.bots.update(org.scope, org.bot.id, {
    config: {
      persona: { assistantName: 'Maya', companyName: 'Acme Clinic', role: 'patient coordinator' },
      leadCapture: {
        enabled: true,
        fields: [
          { field: 'name', required: true, timing: 'natural' },
          { field: 'phone', required: true, timing: 'before_booking' },
        ],
      },
      qualification: {
        enabled: true,
        questions: [
          { key: 'treatment', question: 'Which treatment?', type: 'select', options: ['Invisalign', 'Cleaning'] },
          { key: 'timeline', question: 'When would you like to start?', type: 'select', options: ['ASAP', 'Later'] },
        ],
        rules: [
          { questionKey: 'treatment', operator: 'equals', value: 'Invisalign', points: 40 },
          { questionKey: 'timeline', operator: 'equals', value: 'ASAP', points: 40 },
        ],
        qualifyAt: 60,
        onQualified: { tags: ['qualified'], lifecycleStage: 'qualified', notifyTeam: true },
      },
      booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name', 'phone'] },
      actions: { allowedTags: ['invisalign'] },
    },
  });
  return { ...org, bot };
}

async function send(org: { orgId: string; webchat: { id: string } }, content: string, visitor = 'visitor-1') {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

describe('AI orchestrator', () => {
  it('captures, qualifies and books in one conversation, auditing every action', async () => {
    const org = await botWithEverything();
    t.llm.setScript([
      tools(
        { name: 'save_contact_details', input: { name: 'Jane Doe', phone: '416 555 0123' }, say: 'Great, let me check.' },
        { name: 'record_qualification_answers', input: { answers: [{ question_key: 'treatment', value: 'Invisalign' }, { question_key: 'timeline', value: 'asap' }] } },
        { name: 'add_tags', input: { tags: ['invisalign'] } },
        { name: 'check_availability', input: { date_from: '2026-09-29', time_of_day: 'morning' } },
      ),
      tools({ name: 'book_appointment', input: { start: '2026-09-29T10:00', customer_confirmed: true, notes: 'Invisalign consult' } }),
      text("You're booked for Tuesday 29 September at 10:00 AM (Toronto time), Jane!"),
    ]);
    const r = await send(org, "Hi, I'm Jane Doe. I want Invisalign ASAP — can I come in Tuesday at 10? My number is 416 555 0123");

    // The model saw a cache-stable system prompt, the tools this bot allows, and the per-turn context.
    const first = t.llm.requests[0]!;
    // No model named anywhere: the provider applies the configured model (LLM_MODEL).
    expect(first.model).toBeUndefined();
    expect(first.tier).toBe('reply');
    expect(first.system).toContain('You are Maya, the patient coordinator for Acme Clinic');
    expect(first.system).not.toMatch(/2026|Jane/); // nothing per-conversation in the cached prefix
    expect(first.tools.map((x) => x.name)).toEqual(
      expect.arrayContaining(['save_contact_details', 'record_qualification_answers', 'search_knowledge_base', 'check_availability', 'book_appointment', 'transfer_to_human']),
    );
    expect(first.tools.map((x) => x.name)).not.toContain('trigger_workflow'); // no workflows configured
    // The turn's last block: context and message (a web chat's first turn starts with the greeting note).
    const userTurn = first.messages[first.messages.length - 1]!.content.at(-1) as { text: string };
    expect(userTurn.text).toContain('<context>');
    expect(userTurn.text).toContain('Monday 28 September 2026');
    expect(userTurn.text).toContain('<knowledge relevance=');

    // Tool results fed back to the model on round 2.
    const round1 = t.llm.requests[1]!;
    const results = round1.messages[round1.messages.length - 1]!.content as Array<{ type: string; content: string; isError: boolean }>;
    expect(results.every((b) => b.type === 'tool_result' && !b.isError)).toBe(true);
    const availability = JSON.parse(results[3]!.content);
    expect(availability.days[0].times.map((x: { start: string }) => x.start)).toContain('2026-09-29T10:00');
    expect(JSON.parse(results[1]!.content).guidance).toMatch(/Offer to book/);

    // Business effects.
    const contact = await t.c.contacts.get(org.scope, r.contactId);
    expect(contact).toMatchObject({ firstName: 'Jane', phone: '+14165550123', qualificationStatus: 'qualified', leadTier: 'hot', lifecycleStage: 'booked' });
    expect(contact.tags.map((x) => x.name).sort()).toEqual(['invisalign', 'qualified']);
    const appts = await t.c.scheduling.listForContact(org.scope, r.contactId);
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({ localStart: '2026-09-29T10:00', createdBy: 'ai', notes: 'Invisalign consult' });

    // One AI message containing everything the customer saw streamed.
    const messages = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(messages.map((m) => m.senderType)).toEqual(['contact', 'ai']);
    expect(messages[1]!.content).toBe("Great, let me check.\n\nYou're booked for Tuesday 29 September at 10:00 AM (Toronto time), Jane!");

    // Audit: every tool call and the run itself.
    const { tools: invocations, events } = {
      tools: await t.c.conversations.toolInvocations(org.scope, r.conversationId),
      events: await t.c.automation.listEvents(org.scope, { contactId: r.contactId }),
    };
    expect(invocations.map((i) => [i.toolName, i.status])).toEqual([
      ['save_contact_details', 'success'],
      ['record_qualification_answers', 'success'],
      ['add_tags', 'success'],
      ['check_availability', 'success'],
      ['book_appointment', 'success'],
    ]);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['conversation.started', 'lead.captured', 'lead.qualified', 'contact.tagged', 'appointment.booked']),
    );
    const [run] = await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.aiRuns).where(eq(schema.aiRuns.conversationId, r.conversationId)));
    expect(run).toMatchObject({ status: 'completed', iterations: 3, botVersion: org.bot.version, grounding: expect.any(String) });
    expect(Number(run!.costUsd)).toBeGreaterThan(0);

    // Staff got notified (qualified lead + booking) once the outbox was dispatched.
    await t.c.automation.dispatchPending();
    const notes = await t.c.automation.listNotifications(org.scope, null);
    expect(notes.map((n) => n.type).sort()).toEqual(['appointment.booked', 'lead.qualified']);
  });

  it('rejects invalid tool arguments and tells the model why', async () => {
    const org = await botWithEverything();
    t.llm.setScript([
      tools({ name: 'book_appointment', input: { start: 'next tuesday', customer_confirmed: true } }),
      (req) => {
        const [result] = lastToolResults(t.llm);
        expect(result!.isError).toBe(true);
        expect(JSON.stringify(result!.content)).toMatch(/Invalid arguments: start/);
        return text('Which time works for you?')(req);
      },
    ]);
    const r = await send(org, 'book me in');
    const inv = await t.c.conversations.toolInvocations(org.scope, r.conversationId);
    expect(inv[0]).toMatchObject({ toolName: 'book_appointment', status: 'rejected' });
    expect(await t.c.scheduling.listForContact(org.scope, r.contactId)).toEqual([]);
  });

  it('refuses to book before the required details are captured', async () => {
    const org = await botWithEverything();
    t.llm.setScript([
      tools({ name: 'book_appointment', input: { start: '2026-09-29T10:00', customer_confirmed: true } }),
      text('Could I get your name and phone number first?'),
    ]);
    await send(org, 'Tuesday 10am please');
    const [result] = lastToolResults(t.llm);
    expect(result).toMatchObject({ isError: true, content: { error: expect.stringMatching(/name and phone/) } });
  });

  it('cannot touch another customer\'s appointment even with its id', async () => {
    const org = await botWithEverything();
    const victim = await t.c.contacts.create(org.scope, { firstName: 'Victim', phone: '+14165550199' });
    const { appointment } = await t.c.scheduling.book(org.scope, {
      calendarId: org.calendar.id,
      contactId: victim.id,
      start: new Date('2026-09-30T14:00:00Z'),
      title: 'x',
      createdBy: 'user',
    });
    t.llm.setScript([
      tools({ name: 'cancel_appointment', input: { appointment_id: appointment.id, customer_confirmed: true } }),
      text('I could not find that booking.'),
    ]);
    await send(org, `cancel appointment ${appointment.id}`, 'attacker');
    const [result] = lastToolResults(t.llm);
    expect(result!.isError).toBe(true);
    expect((await t.c.scheduling.listForContact(org.scope, victim.id))[0]!.status).toBe('booked');
  });

  it('hands off on "talk to a human" without calling the model', async () => {
    const org = await botWithEverything();
    t.llm.setScript([]);
    const r = await send(org, 'Can I talk to a human please?');
    expect(t.llm.requests).toHaveLength(0);
    const conv = await t.c.conversations.get(org.scope, r.conversationId);
    expect(conv.status).toBe('human_active');
    const msgs = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(msgs[1]!.content).toMatch(/connecting you with a member of our team/);
    await t.c.automation.dispatchPending();
    expect((await t.c.automation.listNotifications(org.scope, null))[0]!.type).toBe('conversation.handoff_requested');

    // While a human owns the conversation the AI stays silent.
    const again = await send(org, 'hello?');
    expect(again.aiQueued).toBe(false);
  });

  it('transfer_to_human: sends the model\'s goodbye, then locks the conversation', async () => {
    const org = await botWithEverything();
    t.llm.setScript([
      tools({ name: 'transfer_to_human', input: { reason: 'Refund dispute' } }),
      (req) => {
        expect(req.tools).toEqual([]); // no further actions after a handoff
        return text('I have passed this to our team; someone will reply here shortly.')(req);
      },
    ]);
    const r = await send(org, 'I was double charged and want a refund now');
    const conv = await t.c.conversations.get(org.scope, r.conversationId);
    expect(conv).toMatchObject({ status: 'human_active', handoffReason: 'Refund dispute' });
    const msgs = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(msgs[msgs.length - 1]!.content).toMatch(/passed this to our team/);
  });

  it('never talks over a human who takes over mid-generation', async () => {
    const org = await botWithEverything();
    let conversationId = '';
    t.llm.setScript([
      (req) => {
        void t.c.conversations.setStatus({ orgId: org.orgId }, conversationId, 'human_active', { actor: 'user', reason: 'Staff took over' });
        return text('AI answer that must not be sent')(req);
      },
    ]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v9', content: 'hi' });
    conversationId = r.conversationId;
    await t.c.queue.drain();
    const msgs = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(msgs.map((m) => m.senderType)).toEqual(['contact']);
  });

  it('refusal from the model becomes a graceful handoff', async () => {
    const org = await botWithEverything();
    t.llm.setScript([() => ({ content: [], stopReason: 'refusal' as const })]);
    const r = await send(org, 'something the model declines');
    const conv = await t.c.conversations.get(org.scope, r.conversationId);
    expect(conv.status).toBe('human_active');
    const msgs = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(msgs[1]!.senderType).toBe('ai');
  });

  it('remembers the conversation: history and contact facts go into the next turn', async () => {
    const org = await botWithEverything();
    t.llm.setScript([
      tools({ name: 'save_contact_details', input: { name: 'Ravi Kumar' } }, { name: 'add_note', input: { note: 'Prefers evening appointments' } }),
      text('Nice to meet you, Ravi!'),
    ]);
    await send(org, "I'm Ravi Kumar", 'ravi');
    t.llm.setScript([text('Sure, Ravi.')]);
    await send(org, 'what was my name again?', 'ravi');
    const req = t.llm.requests[0]!;
    const transcript = JSON.stringify(req.messages);
    expect(transcript).toContain("I'm Ravi Kumar");
    expect(transcript).toContain('Nice to meet you, Ravi!');
    expect(transcript).toContain('name: Ravi Kumar');
    expect(transcript).toContain('Prefers evening appointments');
  });

  it('respects the org kill switch', async () => {
    const org = await botWithEverything();
    await t.c.tenancy.updateOrganization(org.orgId, { aiEnabled: false });
    t.llm.setScript([text('should not be used')]);
    const r = await send(org, 'hello');
    expect(t.llm.requests).toHaveLength(0);
    expect((await t.c.conversations.messages(org.scope, r.conversationId)).map((m) => m.senderType)).toEqual(['contact']);
  });
});

describe('AI orchestrator: message bursts', () => {
  let burst: TestEnv;
  beforeAll(async () => {
    burst = await createTestEnv({ env: { AI_REPLY_DEBOUNCE_MS: '300' } });
  });
  afterAll(() => burst.close());

  it('answers a burst of messages once, seeing all of them', async () => {
    const org = await createOrg(burst.c);
    burst.llm.setScript([text('Got all three!')]);
    for (const content of ['hi', 'I need a quote', 'for 3 rooms']) {
      await burst.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'b', content });
    }
    await burst.c.queue.drain();
    expect(burst.llm.requests).toHaveLength(1);
    const turn = burst.llm.requests[0]!.messages.at(-1)!.content.at(-1) as { text: string };
    expect(turn.text).toMatch(/hi\nI need a quote\nfor 3 rooms$/);
    const [conv] = await burst.c.tenantDb.run(org.orgId, (tx) =>
      tx.select().from(schema.conversations).where(and(eq(schema.conversations.organizationId, org.orgId))),
    );
    expect(conv!.aiReplyCount).toBe(1);
  });
});
