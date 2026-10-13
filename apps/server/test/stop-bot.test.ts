import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/**
 * Stop Bot: a scenario ("the contact says goodbye") the assistant recognises from its condition and example phrases.
 * It then sends only the business's final message, tags the contact and goes quiet, in a conversation that stays the AI's
 * (nobody is asked to take over), until its time is up or staff resume it. A message that arrived while it was stopped is
 * never answered later.
 */

let t: TestEnv;
beforeAll(async () => {
  // The database stamps rows with the real time, so the clock the turns use follows it.
  t = await createTestEnv({ now: new Date() });
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;

const goodbye = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  name: 'Goodbye Detection',
  condition: 'When the contact says goodbye or similar phrases',
  examples: ['Bye', 'Goodbye', 'Thank you! have a nice day'],
  finalMessage: 'Thank you for your time, Have a nice day.',
  reactivate: { enabled: true, afterMinutes: 1440 },
  tags: ['stop bot'],
  ...over,
});

const patchActions = (org: Org, stopScenarios: unknown[]) =>
  t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { actions: { ...org.bot.config.actions, stopScenarios } } } });

async function say(org: Org, visitor: string, content: string, ...turns: Array<ReturnType<typeof tools> | ReturnType<typeof text>>) {
  t.llm.setScript([...turns, text('(unscripted reply)')]);
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}
const stopBot = (scenario = 'Goodbye Detection', say?: string) => tools({ name: 'stop_bot', input: { scenario }, say });
const transcript = async (org: Org, conversationId: string) =>
  (await t.c.conversations.messages(org.scope, conversationId)).map((m) => `${m.senderType}: ${m.content}`);
const metaOf = async (org: Org, conversationId: string) =>
  (await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId))))[0]!;
const eventTypes = async (org: Org, contactId: string) => (await t.c.automation.listEvents(org.scope, { contactId })).map((e) => e.type);

describe('saving scenarios', () => {
  it('assigns ids, fills defaults, and refuses what would not work', async () => {
    const org = await createOrg(t.c, 'Stop Config Co');
    const ok = await patchActions(org, [{ name: 'Bye', condition: 'The contact says goodbye' }]);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().config.actions.stopScenarios[0]).toMatchObject({
      enabled: false,
      examples: [],
      finalMessage: '',
      reactivate: { enabled: true, afterMinutes: 1440 },
      tags: [],
    });
    expect(ok.json().config.actions.stopScenarios[0].id).toMatch(/^[0-9a-f-]{36}$/);

    expect((await patchActions(org, [goodbye(), goodbye({ name: 'goodbye detection' })])).statusCode).toBe(400);
    expect((await patchActions(org, [goodbye({ condition: '  ' })])).statusCode).toBe(400);
    expect((await patchActions(org, [goodbye({ name: '' })])).statusCode).toBe(400);
    expect((await patchActions(org, [goodbye({ reactivate: { enabled: true, afterMinutes: 0 } })])).statusCode).toBe(400);
    expect((await patchActions(org, [goodbye({ reactivate: { enabled: true, afterMinutes: 50_000 } })])).statusCode).toBe(400);
    expect((await patchActions(org, [goodbye({ examples: Array.from({ length: 11 }, (_, i) => `phrase ${i}`) })])).statusCode).toBe(400);
  });

  it('offers the tool only while a scenario is on, and tells the assistant when to use it', async () => {
    const org = await createOrg(t.c, 'Stop Tool Co');
    const toolsOf = async () => ((await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: authHeaders(org.token) })).json().tools as Array<{ name: string; description: string }>);
    expect((await toolsOf()).some((x) => x.name === 'stop_bot')).toBe(false);

    await patchActions(org, [goodbye({ enabled: false })]);
    expect((await toolsOf()).some((x) => x.name === 'stop_bot')).toBe(false);

    await patchActions(org, [goodbye()]);
    const tool = (await toolsOf()).find((x) => x.name === 'stop_bot')!;
    expect(tool.description).toContain('"Goodbye Detection": When the contact says goodbye or similar phrases');
    expect(tool.description).toContain('"Thank you! have a nice day"');
  });
});

describe('stopping', () => {
  it('sends only the final message, tags the contact and keeps the chat with the AI', async () => {
    const org = await createOrg(t.c, 'Stop Flow Co');
    await patchActions(org, [goodbye()]);
    const before = t.llm.requests.length;
    const r = await say(org, 'v1', 'Thanks, bye!', stopBot('Goodbye Detection', 'You are welcome!'));

    // One model call (no second round), and what the model wrote alongside the call isn't sent.
    expect(t.llm.requests.length - before).toBe(1);
    expect(await transcript(org, r.conversationId)).toEqual(['contact: Thanks, bye!', 'ai: Thank you for your time, Have a nice day.']);

    const conv = await metaOf(org, r.conversationId);
    expect(conv.status).toBe('ai_active');
    const stop = conv.metadata.aiStop as { scenarioName: string; at: string; until: string };
    expect(stop.scenarioName).toBe('Goodbye Detection');
    const hours = (Date.parse(stop.until) - Date.parse(stop.at)) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);

    const tags = await t.c.tenantDb.run(org.orgId, (tx) =>
      tx.select({ name: schema.tags.name }).from(schema.contactTags).innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId)).where(eq(schema.contactTags.contactId, r.contactId)),
    );
    expect(tags.map((x) => x.name)).toEqual(['stop bot']);

    const types = await eventTypes(org, r.contactId);
    expect(types).toContain('conversation.bot_stopped');
    expect(types).not.toContain('conversation.handoff_requested');
    const invocations = await t.c.conversations.toolInvocations(org.scope, r.conversationId);
    expect(invocations.at(-1)).toMatchObject({ toolName: 'stop_bot', status: 'success' });
  });

  it('stays silent afterwards, and the sweeper does not wake it for messages sent while stopped', async () => {
    const org = await createOrg(t.c, 'Stop Silent Co');
    await patchActions(org, [goodbye()]);
    const r = await say(org, 'v2', 'Goodbye', stopBot());

    await say(org, 'v2', 'Actually, one more thing?', text('This must not be sent.'));
    // (Each `say` starts a fresh script, so this counts the model calls of the second message only.)
    expect(t.llm.requests.length).toBe(0);
    await say(org, 'v2', 'Hello??', text('Neither must this.'));
    expect(t.llm.requests.length).toBe(0);
    expect(await transcript(org, r.conversationId)).toEqual(['contact: Goodbye', 'ai: Thank you for your time, Have a nice day.', 'contact: Actually, one more thing?', 'contact: Hello??']);

    for (const minutes of [3, 60, 23 * 60]) {
      t.now.value = new Date(Date.now() + minutes * 60_000);
      expect(await t.c.unansweredSweeper.run()).toBe(0);
    }
    t.now.value = new Date();
  });

  it('with no final message it just goes quiet; a retried stop adds no second tag or event', async () => {
    const org = await createOrg(t.c, 'Stop Quiet Co');
    await patchActions(org, [goodbye({ finalMessage: '' })]);
    const r = await say(org, 'v3', 'ok bye', stopBot());
    expect(await transcript(org, r.conversationId)).toEqual(['contact: ok bye']);
    expect((await metaOf(org, r.conversationId)).metadata.aiStop).toBeTruthy();

    // The same stop again (a turn that was retried): reported as already done.
    const again = await t.c.conversations.stopBot(org.scope, r.conversationId, { scenarioId: 'x', scenarioName: 'Goodbye Detection', until: null, tags: ['stop bot'] });
    expect(again).toBe(false);
    expect((await eventTypes(org, r.contactId)).filter((x) => x === 'conversation.bot_stopped')).toHaveLength(1);
  });

  it('does not stop for a scenario that is off or unknown, and carries on talking', async () => {
    const org = await createOrg(t.c, 'Stop Off Co');
    await patchActions(org, [goodbye({ enabled: false }), goodbye({ name: 'Unsubscribe', condition: 'They ask to stop messages' })]);
    const r = await say(org, 'v4', 'bye', stopBot('Goodbye Detection'), text('Take care!'));
    // The invalid call is refused, the model answers in words, and the chat isn't stopped.
    expect(await transcript(org, r.conversationId)).toEqual(['contact: bye', 'ai: Take care!']);
    expect((await metaOf(org, r.conversationId)).metadata.aiStop).toBeUndefined();
  });
});

describe('starting again', () => {
  it('on its own once the time is up: the first message after that is answered, the ones sent meanwhile are not', async () => {
    const org = await createOrg(t.c, 'Stop Expiry Co');
    await patchActions(org, [goodbye()]);
    const r = await say(org, 'v5', 'bye', stopBot());
    const during = await say(org, 'v5', 'wait, are you there?', text('Not sent.'));

    // The time is up as of the second message.
    const [second] = await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.id, during.message.id)));
    await t.c.tenantDb.run(org.orgId, (tx) =>
      tx
        .update(schema.conversations)
        .set({ metadata: sql`jsonb_set(${schema.conversations.metadata}, '{aiStop,until}', to_jsonb(${second!.createdAt.toISOString()}::text))` })
        .where(eq(schema.conversations.id, r.conversationId)),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    await say(org, 'v5', 'Hi again, do you do whitening?', text('Yes, we do whitening.'));

    expect(await transcript(org, r.conversationId)).toEqual([
      'contact: bye',
      'ai: Thank you for your time, Have a nice day.',
      'contact: wait, are you there?',
      'contact: Hi again, do you do whitening?',
      'ai: Yes, we do whitening.',
    ]);
    expect((await metaOf(org, r.conversationId)).metadata.aiStop).toBeUndefined();
    const types = await eventTypes(org, r.contactId);
    expect(types).toContain('conversation.bot_restarted');
    expect((await t.c.automation.listEvents(org.scope, { contactId: r.contactId })).find((e) => e.type === 'conversation.bot_restarted')).toMatchObject({ actor: 'system' });
  });

  it('without a restart time it stays stopped until staff press Resume AI', async () => {
    const org = await createOrg(t.c, 'Stop Resume Co');
    await patchActions(org, [goodbye({ reactivate: { enabled: false, afterMinutes: 1440 } })]);
    const r = await say(org, 'v6', 'goodbye', stopBot());
    expect(((await metaOf(org, r.conversationId)).metadata.aiStop as { until: string | null }).until).toBeNull();

    await say(org, 'v6', 'hello?', text('Not sent.'));
    t.now.value = new Date(Date.now() + 40 * 3_600_000);
    expect(await t.c.unansweredSweeper.run()).toBe(0);
    t.now.value = new Date();
    expect((await transcript(org, r.conversationId)).filter((x) => x.startsWith('ai:'))).toHaveLength(1);

    const resume = await t.app.inject({ method: 'POST', url: `/v1/conversations/${r.conversationId}/status`, headers: authHeaders(org.token), payload: { action: 'resume' } });
    expect(resume.statusCode, resume.body).toBe(200);
    expect(resume.json().status).toBe('ai_active');
    expect(resume.json().metadata.aiStop).toBeUndefined();
    expect((await t.c.automation.listEvents(org.scope, { contactId: r.contactId })).find((e) => e.type === 'conversation.bot_restarted')).toMatchObject({ actor: 'user' });

    await say(org, 'v6', 'Sorry, one question: opening hours?', text('We open at 9.'));
    expect((await transcript(org, r.conversationId)).at(-1)).toBe('ai: We open at 9.');
  });

  it('a person taking over or closing the chat ends the stop', async () => {
    const org = await createOrg(t.c, 'Stop Takeover Co');
    await patchActions(org, [goodbye()]);
    const r = await say(org, 'v7', 'bye', stopBot());
    const takeover = await t.app.inject({ method: 'POST', url: `/v1/conversations/${r.conversationId}/status`, headers: authHeaders(org.token), payload: { action: 'takeover' } });
    expect(takeover.statusCode, takeover.body).toBe(200);
    expect(takeover.json().status).toBe('human_active');
    expect(takeover.json().metadata.aiStop).toBeUndefined();
  });

  it('the conversation shows that the assistant is stopped, for the team', async () => {
    const org = await createOrg(t.c, 'Stop Detail Co');
    await patchActions(org, [goodbye()]);
    const r = await say(org, 'v8', 'bye', stopBot());
    const detail = await t.app.inject({ method: 'GET', url: `/v1/conversations/${r.conversationId}`, headers: authHeaders(org.token) });
    expect(detail.json().metadata.aiStop).toMatchObject({ scenarioName: 'Goodbye Detection' });
  });
});

describe('other flows are untouched', () => {
  it('a bot with no scenarios talks as before, and other conversations are not stopped', async () => {
    const org = await createOrg(t.c, 'Stop Other Co');
    await patchActions(org, [goodbye()]);
    const a = await say(org, 'a', 'bye', stopBot());
    const b = await say(org, 'b', 'Hello, what are your hours?', text('We are open 9 to 5.'));
    expect((await transcript(org, b.conversationId)).at(-1)).toBe('ai: We are open 9 to 5.');
    expect((await metaOf(org, a.conversationId)).metadata.aiStop).toBeTruthy();
    expect((await metaOf(org, b.conversationId)).metadata.aiStop).toBeUndefined();
  });
});
