import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calendarFieldLabel, calendarProblems, hoursProblem } from '../../dashboard/src/lib/calendarErrors';
import { currentTimezoneName } from '../../dashboard/src/lib/timezones';
import { headerLine, quietNotice } from '../../widget/src/handoff';
import { schema } from '../src/db/client';
import { asksForPerson, MAX_REQUEST_WORDS } from '../src/modules/ai/orchestrator';
import { quietReason } from '../src/modules/ai/quiet';
import { defaultHandoffScenarios } from '../src/modules/bots/config';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * The QA sheet "Human Handover, Stop Bot and Appointment Booking": booking rules and wording (BOOK-001…003, 006),
 * the calendar form (BOOK-004/005), honest handover behaviour (HAND-001…005), and telling the visitor when nobody
 * will answer (STOP-001). The assistant's own wording is a prompt matter, so those checks read the prompt a turn sends.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv({ now: new Date() });
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
const patchBot = (org: Org, body: Record<string, unknown>) => t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: body });
const patchConfig = (org: Org, config: Record<string, unknown>) => patchBot(org, { config });
const tuesday = () => {
  let d = DateTime.now().setZone('America/Toronto').plus({ days: 8 }).startOf('day');
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  return `${d.toFormat('yyyy-MM-dd')}T10:00`;
};
async function say(org: Org, visitor: string, content: string, ...turns: Array<ReturnType<typeof tools> | ReturnType<typeof text>>) {
  t.llm.setScript([...turns, text('(unscripted reply)')]);
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}
const systemOf = () => t.llm.requests[0]!.system;
const convOf = async (org: Org, id: string) => (await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, id))))[0]!;
const aiMessages = async (org: Org, id: string) => (await t.c.conversations.messages(org.scope, id)).filter((m) => m.senderType === 'ai');

describe('BOOK-001: the calendar decides how late a booking can be moved or cancelled', () => {
  it("tells the assistant the calendar's rule and that documents can't change it", async () => {
    const org = await createOrg(t.c, 'Policy Any Time Co');
    await patchConfig(org, { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] } });
    await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, { minCancelNoticeMinutes: null });
    await say(org, 'p1', 'hello', text('Hi'));
    expect(systemOf()).toContain('This calendar lets a booking be moved or cancelled any time before the appointment starts.');
    expect(systemOf()).toMatch(/same for moving and for cancelling/);
    expect(systemOf()).toMatch(/names a different notice period, don't apply it and don't refuse because of it/);
  });

  it('says the real window when the calendar has one', async () => {
    const org = await createOrg(t.c, 'Policy 24h Co');
    await patchConfig(org, { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] } });
    await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, { minCancelNoticeMinutes: 1440 });
    await say(org, 'p2', 'hello', text('Hi'));
    expect(systemOf()).toContain('moved or cancelled 24 hours before the appointment.');
  });

  it('is not said when the assistant cannot move or cancel at all', async () => {
    const org = await createOrg(t.c, 'Policy None Co');
    await patchConfig(org, { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'], allowReschedule: false, allowCancel: false } });
    await say(org, 'p3', 'hello', text('Hi'));
    expect(systemOf()).not.toContain('This calendar lets a booking be moved or cancelled');
  });
});

describe('BOOK-002: with no details ticked, booking asks for none of its own', () => {
  it('says so in the prompt and the tool, and the booking goes through without saved details', async () => {
    const org = await createOrg(t.c, 'No Details Co');
    expect((await patchConfig(org, { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: [] } })).statusCode).toBe(200);
    await say(org, 'nd-1', 'Book me Tuesday 10am', tools({ name: 'book_appointment', input: { start: tuesday(), customer_confirmed: true } }), text('Booked!'));
    expect(systemOf()).toContain('Booking itself needs no contact details.');
    expect(systemOf()).toContain('Booking asks for no contact details of its own');
    expect(systemOf()).not.toMatch(/you have saved their \./);
    expect(lastToolResults(t.llm)[0]).toMatchObject({ isError: false, content: { booked: true } });
    const spec = (await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: authHeaders(org.token) })).json().tools.find((x: { name: string }) => x.name === 'book_appointment');
    expect(spec.description).toContain('No contact details are needed for the booking itself.');
  });

  it('still asks for what is ticked', async () => {
    const org = await createOrg(t.c, 'Some Details Co');
    await patchConfig(org, { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name', 'email'] } });
    await say(org, 'sd-1', 'Book me Tuesday 10am', tools({ name: 'book_appointment', input: { start: tuesday(), customer_confirmed: true } }), text('What is your name and email?'));
    expect(systemOf()).toContain('you have saved their name and email.');
    expect(lastToolResults(t.llm)[0]).toMatchObject({ isError: true });
  });
});

describe('BOOK-003: an empty appointment title falls back to the default', () => {
  it('on the server, for an empty or spaces-only title', async () => {
    const org = await createOrg(t.c, 'Title Co');
    for (const title of ['', '   ']) {
      const res = await patchConfig(org, { booking: { enabled: true, calendarId: org.calendar.id, appointmentTitle: title } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().config.booking.appointmentTitle).toBe('Consultation');
    }
    const named = await patchConfig(org, { booking: { enabled: true, calendarId: org.calendar.id, appointmentTitle: '  Check-up  ' } });
    expect(named.json().config.booking.appointmentTitle).toBe('Check-up');
  });
});

describe('BOOK-004 / BOOK-005: the calendar form says what is wrong, next to the field', () => {
  const base = (over: Record<string, unknown> = {}) =>
    ({
      name: 'Main',
      description: '',
      timezone: 'America/Toronto',
      slotMinutes: 30,
      slotIntervalMinutes: null,
      bufferMinutes: 0,
      minNoticeMinutes: 120,
      maxDaysAhead: 30,
      maxPerDay: null,
      weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] },
      dateOverrides: [],
      isActive: true,
      location: '',
      customerInstructions: '',
      sendConfirmations: true,
      reminderMinutes: [1440],
      replyToEmail: null,
      minCancelNoticeMinutes: null,
      ...over,
    }) as Parameters<typeof calendarProblems>[0];

  it('accepts a normal calendar', () => {
    expect(calendarProblems(base()).count).toBe(0);
  });

  it('marks each bad number in plain words (the sheet\'s values)', () => {
    const p = calendarProblems(base({ slotMinutes: 0, bufferMinutes: -10, minNoticeMinutes: -5, maxDaysAhead: 99999, maxPerDay: -3 }));
    expect(p.fields.slotMinutes).toBe('Appointment length must be at least 5 minutes.');
    expect(p.fields.bufferMinutes).toBe("Buffer can't be negative.");
    expect(p.fields.minNoticeMinutes).toBe("Minimum notice can't be negative.");
    expect(p.fields.maxDaysAhead).toBe('Booking window can be at most 365 days.');
    expect(p.fields.maxPerDay).toBe('Max per day must be at least 1.');
    expect(p.count).toBe(5);
    for (const message of Object.values(p.fields)) expect(message).not.toMatch(/slotMinutes|bufferMinutes|minNoticeMinutes|maxDaysAhead|maxPerDay/);
  });

  it('marks a closing time before the opening time, overlapping hours and a bad reply-to email', () => {
    const p = calendarProblems(base({ weeklyHours: { mon: [{ start: '09:00', end: '08:00' }], tue: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] }, replyToEmail: 'not-an-email' }));
    expect(p.days.mon).toBe('Monday: Closing time (08:00) must be after opening time (09:00).');
    expect(p.days.tue).toContain('overlap');
    expect(p.fields.replyToEmail).toContain('valid email address');
    expect(hoursProblem([{ start: '', end: '10:00' }])).toBe('Set both an opening and a closing time.');
    expect(hoursProblem([{ start: '09:00', end: '24:00' }])).toBeNull();
  });

  it('needs a name, and names the day or date for each hours problem', () => {
    expect(calendarProblems(base({ name: '   ' })).fields.name).toBe('Name is required.');
    const p = calendarProblems(base({ dateOverrides: [{ date: '', hours: [] }, { date: '2026-12-25', hours: [{ start: '10:00', end: '09:00' }] }] }));
    expect(p.overrides[0]).toBe('Choose the date.');
    expect(p.overrides[1]).toContain('must be after opening time');
  });

  it('leaves the optional limits alone when they are empty', () => {
    expect(calendarProblems(base({ slotIntervalMinutes: null, maxPerDay: null, minCancelNoticeMinutes: null })).count).toBe(0);
    expect(calendarProblems(base({ slotIntervalMinutes: 2 })).fields.slotIntervalMinutes).toContain('at least 5');
  });

  it('names server errors for a calendar as the person sees them', () => {
    expect(calendarFieldLabel('slotMinutes')).toBe('Appointment length');
    expect(calendarFieldLabel('weeklyHours.mon')).toBe('Monday hours');
    expect(calendarFieldLabel('replyToEmail')).toBe('Reply-to email');
    expect(calendarFieldLabel('somethingNew')).toBe('');
  });

  it('the server still refuses what the form refuses', async () => {
    const org = await createOrg(t.c, 'Calendar Server Co');
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/calendars',
      headers: authHeaders(org.token),
      payload: { name: 'Bad', timezone: 'America/Toronto', slotMinutes: 0, bufferMinutes: -10 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('BOOK-006: one name for a timezone everywhere', () => {
  it('shows the current name for the old one the browser lists', () => {
    expect(currentTimezoneName('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(currentTimezoneName('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(currentTimezoneName('America/Toronto')).toBe('America/Toronto');
    expect(currentTimezoneName('Europe/Kiev')).toBe('Europe/Kyiv');
  });
});

describe('HAND-001: repeated failure is a handover, not another apology', () => {
  it('spells out when Failed to resolve issue applies, and that it comes before apologising or asking for details', async () => {
    const org = await createOrg(t.c, 'Failed Hint Co');
    await patchConfig(org, { handoff: { enabled: true } });
    await say(org, 'f1', 'hello', text('Hi'));
    expect(systemOf()).toContain('Failed to resolve issue: Multiple attempts to resolve the issue has failed. This applies as soon as the customer says your answers');
    expect(systemOf()).toContain("Don't apologise again or ask for contact details at that point: hand over");
  });

  it('does the same for Lack of information, and adds nothing for a scenario that is off or custom', async () => {
    const org = await createOrg(t.c, 'Lack Hint Co');
    const handoff = (await t.c.bots.get(org.scope, org.bot.id)).config.handoff;
    const scenarios = [
      ...handoff.scenarios.map((s) => ({ ...s, enabled: s.preset === 'lack_of_information' })),
      { name: 'VIP', condition: 'A VIP customer', examples: [], enabled: true, finalMessage: 'On it.', preset: null },
    ];
    expect((await patchConfig(org, { handoff: { ...handoff, scenarios } })).statusCode).toBe(200);
    await say(org, 'l1', 'hello', text('Hi'));
    expect(systemOf()).toContain('This applies when the business facts, the <knowledge> snippets and your tools cannot answer a business question');
    expect(systemOf()).not.toContain('Failed to resolve issue:');
    expect(systemOf()).toContain('- VIP: A VIP customer\n');
  });

  it('the model can hand over with the scenario, and its message goes out', async () => {
    const org = await createOrg(t.c, 'Failed Handover Co');
    await patchConfig(org, { handoff: { enabled: true } });
    const r = await say(org, 'f2', 'This is the third time, you cannot solve my problem', tools({ name: 'transfer_to_human', input: { reason: 'third failed answer', scenario: 'Failed to resolve issue' } }));
    expect((await convOf(org, r.conversationId)).status).toBe('human_active');
  });
});

describe('HAND-002: the assistant only offers a follow-up it can really make', () => {
  it('asks for details and then creates the task, when create_task is available', async () => {
    const org = await createOrg(t.c, 'Follow Up Co');
    await say(org, 'fu-1', 'hello', text('Hi'));
    expect(systemOf()).toContain('call create_task so the follow-up really exists, and only then tell them the team will be in touch');
    expect(systemOf()).toContain('Never say the team will follow up unless you called create_task');
  });

  it("does not promise a follow-up when create_task is off and no handover scenario is on", async () => {
    const org = await createOrg(t.c, 'No Follow Up Co');
    const handoff = (await t.c.bots.get(org.scope, org.bot.id)).config.handoff;
    await patchConfig(org, {
      handoff: { ...handoff, scenarios: handoff.scenarios.map((s) => ({ ...s, enabled: false })) },
      actions: { ...org.bot.config.actions, disabledTools: ['create_task'] },
    });
    await say(org, 'nf-1', 'hello', text('Hi'));
    expect(systemOf()).not.toContain('offer to have the team follow up');
    expect(systemOf()).toContain('do not promise that the team will get back to them');
  });

  it('"offer to connect them" needs a handover scenario; without one it falls back to the honest wording', async () => {
    const org = await createOrg(t.c, 'Connect Co');
    const handoff = (await t.c.bots.get(org.scope, org.bot.id)).config.handoff;
    await patchConfig(org, {
      handoff: { ...handoff, scenarios: handoff.scenarios.map((s) => ({ ...s, enabled: false })) },
      guardrails: { ...org.bot.config.guardrails, unknownAnswer: 'offer_handoff' },
      actions: { ...org.bot.config.actions, disabledTools: ['create_task'] },
    });
    await say(org, 'co-1', 'hello', text('Hi'));
    expect(systemOf()).not.toContain('offer to connect them with the team');
    expect(systemOf()).toContain('do not promise that the team will get back to them');
    const on = await createOrg(t.c, 'Connect On Co');
    await patchConfig(on, { handoff: { enabled: true }, guardrails: { ...on.bot.config.guardrails, unknownAnswer: 'offer_handoff' } });
    await say(on, 'co-2', 'hello', text('Hi'));
    expect(systemOf()).toContain('say you are not sure and offer to connect them with the team');
  });
});

describe('HAND-003: a trigger phrase inside a long message is not an instant handover', () => {
  const keywords = ['talk to a human', 'real person'];
  it('hands over at once for a request that is mostly the phrase', () => {
    for (const ok of ['I want to talk to a human', 'REAL PERSON PLEASE', 'Can I talk to a human please?', 'Hi there, I would like to talk to a human about my invoice now']) {
      expect(asksForPerson(ok, keywords), ok).toBe(true);
    }
  });

  it('leaves a long message with a question in it to the assistant', () => {
    const long = 'Hi there, my name is Sam and earlier a friend said I should talk to a human about pricing, what are your prices?';
    expect(long.split(/\s+/).length).toBeGreaterThan(MAX_REQUEST_WORDS);
    expect(asksForPerson(long, keywords)).toBe(false);
    // And a message without a phrase is never an instant handover.
    expect(asksForPerson('what are your prices', keywords)).toBe(false);
  });

  it('in a real turn: the long message gets an answer, the short request a handover', async () => {
    const org = await createOrg(t.c, 'Phrase Co');
    await patchConfig(org, { handoff: { enabled: true } });
    const long = await say(org, 'ph-1', 'Hi there, my name is Sam and earlier a friend said I should talk to a human about pricing, what are your prices?', text('Our prices start at $20.'));
    expect((await convOf(org, long.conversationId)).status).toBe('ai_active');
    expect((await aiMessages(org, long.conversationId)).at(-1)!.content).toBe('Our prices start at $20.');
    const short = await say(org, 'ph-2', 'I want to talk to a human', text('should not be used'));
    expect((await convOf(org, short.conversationId)).status).toBe('human_active');
    expect(t.llm.requests).toHaveLength(0);
  });
});

describe('HAND-004: sources only where the documents were used', () => {
  async function withFaq(name: string) {
    const org = await createOrg(t.c, name);
    await t.c.knowledge.createFaqDocument(org.scope, org.kb.id, {
      title: 'FAQ',
      category: 'faq',
      faq: [
        { question: 'What are your opening hours?', answer: 'We are open Monday to Friday from 9 AM to 5 PM.' },
        { question: 'Where are you located?', answer: 'Our clinic is at 12 Main Street.' },
      ],
    });
    await t.c.queue.drain();
    await patchConfig(org, { handoff: { enabled: true } });
    return org;
  }
  const withUrl = async (org: Org) => {
    // Sources are listed when they have a link: give the document one.
    await t.c.tenantDb.run(org.orgId, (tx) => tx.update(schema.documents).set({ sourceUri: 'https://example.com/faq' }).where(eq(schema.documents.knowledgeBaseId, org.kb.id)));
  };

  it('a handover message carries none, though the question matched the documents', async () => {
    const org = await withFaq('Source Handover Co');
    await withUrl(org);
    const r = await say(org, 's1', 'What are your opening hours? I am unhappy and want a manager', tools({ name: 'transfer_to_human', input: { reason: 'upset', scenario: 'Complaint or sensitive issue' } }));
    expect((await convOf(org, r.conversationId)).status).toBe('human_active');
    const last = (await aiMessages(org, r.conversationId)).at(-1)!;
    expect(last.citations).toEqual([]);
  });

  it('an answer that did use the documents still lists them', async () => {
    const org = await withFaq('Source Used Co');
    await withUrl(org);
    const r = await say(org, 's2', 'What are your opening hours?', text('We are open Monday to Friday from 9 AM to 5 PM.'));
    const last = (await aiMessages(org, r.conversationId)).at(-1)!;
    expect(last.citations.length).toBeGreaterThan(0);
    expect(last.citations[0]!.title).toContain('FAQ');
  });

  it('an answer about something the documents do not cover lists nothing', async () => {
    const org = await withFaq('Source Unrelated Co');
    await withUrl(org);
    const r = await say(org, 's3', 'How much does the premium plan cost per year?', text("I don't have the price of the premium plan."));
    const last = (await aiMessages(org, r.conversationId)).at(-1)!;
    expect(last.citations).toEqual([]);
  });
});

describe('HAND-005: scenario defaults', () => {
  it('a migrated bot shows the four ready-made scenarios alike, and says so in their settings', async () => {
    const org = await createOrg(t.c, 'Defaults Alike Co');
    const handoff = (await t.c.bots.get(org.scope, org.bot.id)).config.handoff;
    for (const s of handoff.scenarios) {
      expect(s.createTask, s.name).toBe(false);
      expect(s.reactivate.enabled, s.name).toBe(false);
      expect(s.tags, s.name).toEqual([]);
    }
  });

  it('a new agent still starts with the GHL defaults (task and take-back on), all off', () => {
    for (const s of defaultHandoffScenarios()) {
      expect(s.enabled).toBe(false);
      expect(s.createTask).toBe(true);
      expect(s.reactivate).toEqual({ enabled: true, afterMinutes: 480 });
    }
  });
});

describe('STOP-001: the visitor is told when nobody will answer', () => {
  const state = (over: Partial<Parameters<typeof quietReason>[0]> = {}) => ({ status: 'ai_active', metadata: {}, hasBot: true, botActive: true, aiEnabled: true, ...over });

  it('works out why: agent off, AI off for the organization, no agent, or a stop in force', () => {
    const now = new Date();
    expect(quietReason(state(), now)).toBeNull();
    expect(quietReason(state({ botActive: false }), now)).toBe('off');
    expect(quietReason(state({ aiEnabled: false }), now)).toBe('off');
    expect(quietReason(state({ hasBot: false }), now)).toBe('off');
    const stop = (until: string | null) => ({ aiStop: { scenarioId: 'x', scenarioName: 'Goodbye', at: now.toISOString(), until } });
    expect(quietReason(state({ metadata: stop(null) }), now)).toBe('stopped');
    expect(quietReason(state({ metadata: stop(new Date(now.getTime() + 3_600_000).toISOString()) }), now)).toBe('stopped');
    // A stop whose time is up isn't one, and a chat with the team or a closed one isn't "quiet".
    expect(quietReason(state({ metadata: stop(new Date(now.getTime() - 1000).toISOString()) }), now)).toBeNull();
    expect(quietReason(state({ status: 'human_active', botActive: false }), now)).toBeNull();
    expect(quietReason(state({ status: 'closed', metadata: stop(null) }), now)).toBeNull();
  });

  it('the widget header and notice say it', () => {
    expect(headerLine('ai_active', false, 'Ava · usually replies instantly')).toBe('Ava · usually replies instantly');
    expect(headerLine('ai_active', false, 'Ava · usually replies instantly', 'off')).toBe('Not replying right now');
    expect(headerLine('ai_active', false, 'Ava · usually replies instantly', 'stopped')).toBe('This chat has ended');
    expect(headerLine('human_active', false, 'usual', 'off')).toBe('Waiting for a team member…');
    expect(quietNotice('off')).toContain("switched off right now");
    expect(quietNotice('stopped')).toContain('has ended');
  });

  async function widgetSession(org: Org, visitorId: string) {
    const key = (await t.c.channels.get({ orgId: org.orgId }, org.webchat.id)).publicKey;
    const s = await t.app.inject({ method: 'POST', url: '/widget/v1/sessions', payload: { key, visitorId } });
    expect(s.statusCode, s.body).toBe(200);
    return { token: s.json().token as string, session: s.json() };
  }
  const send = (token: string, content: string) =>
    t.app.inject({ method: 'POST', url: '/widget/v1/messages', headers: { authorization: `Bearer ${token}` }, payload: { content } });

  it('Mode Off: the session and the message response say the agent is off, with no typing', async () => {
    const org = await createOrg(t.c, 'Mode Off Co');
    const { token, session } = await widgetSession(org, 'visitor-off-0001');
    expect(session.quiet).toBeNull();
    expect((await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { isActive: false } })).statusCode).toBe(200);
    const again = await widgetSession(org, 'visitor-off-0001');
    expect(again.session.quiet).toBe('off');
    const sent = await send(again.token, 'Hello, are you open on Monday?');
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ aiQueued: true, quiet: 'off' });
    void token;
  });

  it('after a Stop Bot goodbye the next message is answered with a notice, not silence', async () => {
    const org = await createOrg(t.c, 'Stop Notice Co');
    const stopScenario = { enabled: true, name: 'Goodbye Detection', condition: 'The contact says goodbye', examples: ['bye'], finalMessage: 'Take care!', reactivate: { enabled: true, afterMinutes: 1440 }, tags: [] };
    await patchConfig(org, { actions: { ...org.bot.config.actions, stopScenarios: [stopScenario] } });
    const { token } = await widgetSession(org, 'visitor-stop-0001');
    t.llm.setScript([tools({ name: 'stop_bot', input: { scenario: 'Goodbye Detection' } })]);
    expect((await send(token, 'Ok thanks, bye!')).statusCode).toBe(201);
    await t.c.queue.drain();
    t.llm.setScript([text('should not be sent')]);
    const second = await send(token, 'Wait, what are your hours?');
    expect(second.json()).toMatchObject({ aiQueued: true, quiet: 'stopped' });
    await t.c.queue.drain();
    expect(t.llm.requests).toHaveLength(0);
    // Reloading the window tells the visitor up front.
    const reloaded = await widgetSession(org, 'visitor-stop-0001');
    expect(reloaded.session.quiet).toBe('stopped');
    expect(reloaded.session.status).toBe('ai_active');
  });

  it('a chat the assistant is answering is not marked quiet', async () => {
    const org = await createOrg(t.c, 'Not Quiet Co');
    const { token } = await widgetSession(org, 'visitor-live-0001');
    t.llm.setScript([text('Hi!')]);
    const sent = await send(token, 'hello');
    expect(sent.json().quiet).toBeNull();
    await t.c.queue.drain();
  });
});
