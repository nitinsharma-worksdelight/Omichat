import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { LlmError } from '../src/modules/ai/llm/types';
import { SYSTEM_HANDOFF_MESSAGE } from '../src/modules/bots/config';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/**
 * Human Handover is scenario-based, as in GHL: handover is on while a scenario is, Human Requested's example phrases
 * are the instant trigger phrases, and each scenario has its own message, team member, task, tags and take-back time.
 * Bots from before scenarios are migrated so they hand over exactly as they did; new agents start with GHL's three, off.
 * Handoffs no scenario covers (reply limit, budget, errors) keep working with the system's own message.
 */

let t: TestEnv;
beforeAll(async () => {
  // The database stamps rows with the real time, so the clock the turns use follows it.
  t = await createTestEnv({ now: new Date() });
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
type Scenario = Record<string, unknown> & { name: string; enabled: boolean };

const OLD_MESSAGE = "I'm connecting you with a member of our team. They'll reply here as soon as possible.";
const OLD_KEYWORDS = ['talk to a human', 'real person', 'speak to someone', 'human agent', 'customer service', 'representative'];

const bot = async (org: Org, botId: string) => (await t.app.inject({ method: 'GET', url: `/v1/bots/${botId}`, headers: authHeaders(org.token) })).json();
const patchBot = (org: Org, botId: string, body: Record<string, unknown>) => t.app.inject({ method: 'PATCH', url: `/v1/bots/${botId}`, headers: authHeaders(org.token), payload: body });
const preview = async (org: Org, botId: string) =>
  (await t.app.inject({ method: 'GET', url: `/v1/bots/${botId}/preview`, headers: authHeaders(org.token) })).json() as { system: string; tools: Array<{ name: string; description: string }> };

/** A new agent, as Create Agent makes it, answering the organization's website chat. */
async function newAgent(org: Org) {
  const created = await t.app.inject({ method: 'POST', url: '/v1/bots', headers: authHeaders(org.token), payload: { name: 'New Agent' } });
  expect(created.statusCode, created.body).toBe(201);
  const moved = await t.app.inject({ method: 'PATCH', url: `/v1/channels/${org.webchat.id}`, headers: authHeaders(org.token), payload: { botId: created.json().id } });
  expect(moved.statusCode, moved.body).toBe(200);
  return created.json() as { id: string; config: { handoff: { enabled: boolean; keywords: string[]; scenarios: Scenario[] } } };
}
/** Changes the named scenarios of a bot (the rest as they are). */
async function configure(org: Org, botId: string, changes: Record<string, Partial<Scenario>>, extra: Scenario[] = []) {
  const current = await bot(org, botId);
  const scenarios = [...current.config.handoff.scenarios.map((s: Scenario) => ({ ...s, ...(changes[s.name] ?? {}) })), ...extra];
  const res = await patchBot(org, botId, { config: { handoff: { ...current.config.handoff, scenarios } } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const member = async (org: Org, name = 'Maya') => (await t.c.tenancy.addMember(org.orgId, { email: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@example.com`, role: 'agent', password: 'password-123', name })).userId;

async function say(org: Org, visitor: string, content: string, ...turns: Array<ReturnType<typeof tools> | ReturnType<typeof text>>) {
  t.llm.setScript([...turns, text('(an ordinary reply)')]);
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}
const transfer = (reason: string, scenario?: string, say?: string) => tools({ name: 'transfer_to_human', input: scenario ? { reason, scenario } : { reason }, say });
const convOf = async (org: Org, id: string) => (await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, id))))[0]!;
const lastAi = async (org: Org, id: string) => (await t.c.conversations.messages(org.scope, id)).filter((m) => m.senderType === 'ai').at(-1)?.content;
const tasksOf = (org: Org, contactId: string) => t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.tasks).where(eq(schema.tasks.contactId, contactId)));
const tagsOf = async (org: Org, contactId: string) =>
  (
    await t.c.tenantDb.run(org.orgId, (tx) =>
      tx.select({ name: schema.tags.name }).from(schema.contactTags).innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId)).where(eq(schema.contactTags.contactId, contactId)),
    )
  ).map((x) => x.name);

describe('bots from before scenarios hand over as they did', () => {
  it('handoff on: Human Requested with the old phrases and message, Failed to resolve issue and Complaint on, nothing extra', async () => {
    const org = await createOrg(t.c, 'Migrated On Co');
    const { handoff } = (await bot(org, org.bot.id)).config;
    expect(handoff.enabled).toBe(true);
    expect(handoff.scenarios.map((s: Scenario) => [s.name, s.enabled])).toEqual([
      ['Human Requested', true],
      ['Lack of information', false],
      ['Failed to resolve issue', true],
      ['Complaint or sensitive issue', true],
    ]);
    const human = handoff.scenarios[0];
    expect(human).toMatchObject({ examples: OLD_KEYWORDS, finalMessage: OLD_MESSAGE, assignTo: null, createTask: false, tags: [], reactivate: { enabled: false } });
    expect(handoff.keywords).toEqual(OLD_KEYWORDS);
    // Read again: the same ids (nothing was saved yet).
    expect((await bot(org, org.bot.id)).config.handoff.scenarios.map((s: Scenario) => s.id)).toEqual(handoff.scenarios.map((s: Scenario) => s.id));

    // A trigger phrase: straight to the team with the old message, no model call, no task or tag.
    const r = await say(org, 'm1', 'Can I talk to a human please?');
    expect(t.llm.requests).toHaveLength(0);
    expect(await lastAi(org, r.conversationId)).toBe(OLD_MESSAGE);
    const conv = await convOf(org, r.conversationId);
    expect(conv.status).toBe('human_active');
    expect(conv.metadata.reactivateAt).toBeUndefined();
    expect(await tasksOf(org, r.contactId)).toHaveLength(0);
    expect(await tagsOf(org, r.contactId)).toEqual([]);

    // The assistant handing over for an upset customer still works, as the Complaint scenario.
    const upset = await say(org, 'm2', 'You charged me twice!', transfer('Billing dispute', 'Complaint or sensitive issue'));
    expect(await lastAi(org, upset.conversationId)).toBe(OLD_MESSAGE);
    expect((await convOf(org, upset.conversationId)).handoffReason).toBe('Complaint or sensitive issue: Billing dispute');
  });

  it('custom phrases and message carry over; handoff off migrates to everything off', async () => {
    const org = await createOrg(t.c, 'Migrated Custom Co');
    expect((await patchBot(org, org.bot.id, { config: { handoff: { enabled: true, keywords: ['need a person'], message: 'One moment, please.' } } })).statusCode).toBe(200);
    const r = await say(org, 'c1', 'I need a person now');
    expect(await lastAi(org, r.conversationId)).toBe('One moment, please.');

    expect((await patchBot(org, org.bot.id, { config: { handoff: { enabled: false } } })).statusCode).toBe(200);
    const { handoff } = (await bot(org, org.bot.id)).config;
    expect(handoff.enabled).toBe(false);
    expect(handoff.scenarios.every((s: Scenario) => !s.enabled)).toBe(true);
    expect((await preview(org, org.bot.id)).tools.some((x) => x.name === 'transfer_to_human')).toBe(false);
    const off = await say(org, 'c2', 'I need a person now', text('Happy to help here.'));
    expect(await lastAi(org, off.conversationId)).toBe('Happy to help here.');
    expect((await convOf(org, off.conversationId)).status).toBe('ai_active');
  });
});

describe('new agents', () => {
  it("start with GHL's three scenarios, off: no handover, trigger phrases are just messages", async () => {
    const org = await createOrg(t.c, 'New Agent Co');
    const agent = await newAgent(org);
    expect(agent.config.handoff.enabled).toBe(false);
    expect(agent.config.handoff.scenarios.map((s) => [s.name, s.enabled, s.preset])).toEqual([
      ['Human Requested', false, 'human_requested'],
      ['Lack of information', false, 'lack_of_information'],
      ['Failed to resolve issue', false, 'failed_to_resolve'],
    ]);
    expect(agent.config.handoff.scenarios[0]).toMatchObject({ tags: ['human handover'], createTask: true, reactivate: { enabled: true, afterMinutes: 480 } });
    expect((await preview(org, agent.id)).tools.some((x) => x.name === 'transfer_to_human')).toBe(false);
    expect((await preview(org, agent.id)).system).not.toContain('Handing off to a person');

    const r = await say(org, 'n1', 'I want to talk to a human', text('I can help you here.'));
    expect(await lastAi(org, r.conversationId)).toBe('I can help you here.');
    expect((await convOf(org, r.conversationId)).status).toBe('ai_active');
  });
});

describe('scenarios', () => {
  it('Human Requested: its message, its person, a task due in a day, its tag and the take-back plan', async () => {
    const org = await createOrg(t.c, 'Scenario Human Co');
    const agent = await newAgent(org);
    const maya = await member(org, 'Maya');
    await configure(org, agent.id, { 'Human Requested': { enabled: true, assignTo: maya } });
    const tool = (await preview(org, agent.id)).tools.find((x) => x.name === 'transfer_to_human')!;
    expect(tool.description).toContain('"Human Requested": Direct request to speak with human. Examples: "I want to talk to the manager"');

    const r = await say(org, 'h1', 'Could you get me your manager?', transfer('Wants the manager', 'Human Requested', 'One sec.'));
    expect(t.llm.requests).toHaveLength(1);
    expect((await t.c.conversations.messages(org.scope, r.conversationId)).map((m) => m.content)).toEqual([
      'Could you get me your manager?',
      "Sure! I'm transferring your request to a human agent. Someone from the team will get back to you shortly.",
    ]);
    const conv = await convOf(org, r.conversationId);
    expect(conv).toMatchObject({ status: 'human_active', assignedUserId: maya, handoffReason: 'Human Requested: Wants the manager' });
    expect((Date.parse(conv.metadata.reactivateAt as string) - Date.now()) / 3_600_000).toBeCloseTo(8, 1);
    const [task] = await tasksOf(org, r.contactId);
    expect(task).toMatchObject({ title: 'Follow up: Human Requested', assigneeUserId: maya, conversationId: r.conversationId });
    expect((task!.dueAt!.getTime() - Date.now()) / 3_600_000).toBeCloseTo(24, 1);
    expect(await tagsOf(org, r.contactId)).toEqual(['human handover']);

    // Its example phrases hand over at once, without the AI.
    const instant = await say(org, 'h2', 'Hi, I want to talk to a human');
    expect(t.llm.requests).toHaveLength(0);
    expect((await convOf(org, instant.conversationId)).handoffReason).toBe('Human Requested: Customer asked for a person');
  });

  it('Lack of information, Failed to resolve issue and a custom scenario each use their own settings', async () => {
    const org = await createOrg(t.c, 'Scenario Each Co');
    const agent = await newAgent(org);
    const sam = await member(org, 'Sam');
    const refund: Scenario = {
      preset: null,
      enabled: true,
      name: 'Refund request',
      condition: 'The customer asks for a refund',
      examples: ['I want my money back'],
      assignTo: sam,
      finalMessage: 'Our billing team will sort out your refund.',
      createTask: false,
      reactivate: { enabled: false, afterMinutes: 60 },
      tags: ['refund'],
    };
    const saved = await configure(org, agent.id, { 'Lack of information': { enabled: true }, 'Failed to resolve issue': { enabled: true } }, [refund]);
    expect(saved.config.handoff.keywords).toEqual([]);
    expect((await preview(org, agent.id)).system).toContain('- Lack of information: The AI cannot find the relevant information');

    const lack = await say(org, 'e1', 'Do you treat horses?', transfer('Not in the knowledge base', 'Lack of information'));
    expect(await lastAi(org, lack.conversationId)).toMatch(/^I'm sorry, but I don't have the answer/);
    expect((await convOf(org, lack.conversationId)).assignedUserId).toBeNull();
    expect(await tasksOf(org, lack.contactId)).toHaveLength(1);

    const failed = await say(org, 'e2', 'Still broken', transfer('Two fixes failed', 'Failed to resolve issue'));
    expect(await lastAi(org, failed.conversationId)).toMatch(/^Apologies, but I'm unable to process your request/);

    const custom = await say(org, 'e3', 'I want my money back', transfer('Refund', 'Refund request'));
    expect(await lastAi(org, custom.conversationId)).toBe(refund.finalMessage);
    const conv = await convOf(org, custom.conversationId);
    expect(conv).toMatchObject({ assignedUserId: sam, handoffReason: 'Refund request: Refund' });
    expect(conv.metadata.reactivateAt).toBeUndefined();
    expect(await tasksOf(org, custom.contactId)).toHaveLength(0);
    expect(await tagsOf(org, custom.contactId)).toEqual(['refund']);
  });

  it('switching a scenario off takes it out of the tool, the prompt and the trigger phrases', async () => {
    const org = await createOrg(t.c, 'Scenario Off Co');
    const agent = await newAgent(org);
    await configure(org, agent.id, { 'Human Requested': { enabled: true }, 'Lack of information': { enabled: true } });
    await configure(org, agent.id, { 'Human Requested': { enabled: false } });
    const p = await preview(org, agent.id);
    expect(p.tools.find((x) => x.name === 'transfer_to_human')!.description).not.toContain('Human Requested');
    expect(p.system).not.toContain('Human Requested');
    const r = await say(org, 'o1', 'I want to talk to a human', text('Sure, how can I help?'));
    expect((await convOf(org, r.conversationId)).status).toBe('ai_active');
    // Naming a switched-off scenario is refused: the model answers in words and nothing is handed over.
    const named = await say(org, 'o2', 'hm', transfer('x', 'Human Requested'), text('How can I help?'));
    expect((await convOf(org, named.conversationId)).status).toBe('ai_active');
  });

  it('outside team hours the away message replaces the scenario message, when that is on', async () => {
    const org = await createOrg(t.c, 'Scenario Hours Co');
    const agent = await newAgent(org);
    const current = await bot(org, agent.id);
    const scenarios = current.config.handoff.scenarios.map((s: Scenario) => (s.name === 'Human Requested' ? { ...s, enabled: true } : s));
    expect((await patchBot(org, agent.id, { config: { handoff: { ...current.config.handoff, scenarios, respectTeamHours: true, awayMessage: 'We are away until 9.' } } })).statusCode).toBe(200);
    // Team hours on, with no open hours: always away.
    await t.c.tenancy.updateOrganization(org.orgId, { settings: { teamHours: { enabled: true, weekly: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } } } });
    const r = await say(org, 'a1', 'I want to talk to a human');
    expect(await lastAi(org, r.conversationId)).toBe('We are away until 9.');
  });

  it('refuses scenarios that would not work', async () => {
    const org = await createOrg(t.c, 'Scenario Invalid Co');
    const agent = await newAgent(org);
    const { handoff } = (await bot(org, agent.id)).config;
    const send = (scenarios: unknown[]) => patchBot(org, agent.id, { config: { handoff: { ...handoff, scenarios } } });
    const base = handoff.scenarios as Scenario[];
    expect((await send([...base, { ...base[0], id: undefined }])).statusCode).toBe(400);
    expect((await send([{ ...base[0], finalMessage: ' ' }])).statusCode).toBe(400);
    expect((await send([{ ...base[0], reactivate: { enabled: true, afterMinutes: 0 } }])).statusCode).toBe(400);
    const extra = (n: number) => ({ ...base[1], id: undefined, preset: null, name: `Extra ${n}` });
    expect((await send([...base, extra(1), extra(2), extra(3)])).statusCode).toBe(200);
    expect((await send([...base, extra(1), extra(2), extra(3), extra(4)])).statusCode).toBe(400);
    const stranger = await t.c.tenancy.addMember((await createOrg(t.c, 'Elsewhere Co')).orgId, { email: `x-${Date.now()}@example.com`, role: 'agent', password: 'password-123' });
    const notOurs = await send([{ ...base[0], assignTo: stranger.userId }]);
    expect(notOurs.statusCode).toBe(400);
    expect(notOurs.body).toContain('not on your team');
  });
});

describe('handoffs no scenario covers', () => {
  it('the AI reply limit hands over with the system message while a scenario is on, not when none is', async () => {
    const org = await createOrg(t.c, 'Limit Co');
    const agent = await newAgent(org);
    await patchBot(org, agent.id, { config: { guardrails: { ...(await bot(org, agent.id)).config.guardrails, maxAiRepliesPerConversation: 1 } } });
    await say(org, 'l1', 'Hello', text('Hi!'));
    const none = await say(org, 'l1', 'Another question', text('Sure.'));
    expect((await convOf(org, none.conversationId)).status).toBe('ai_active');

    await configure(org, agent.id, { 'Failed to resolve issue': { enabled: true } });
    await say(org, 'l2', 'Hello', text('Hi!'));
    const capped = await say(org, 'l2', 'Another question', text('Not sent.'));
    expect(await lastAi(org, capped.conversationId)).toBe(SYSTEM_HANDOFF_MESSAGE);
    expect((await convOf(org, capped.conversationId)).handoffReason).toBe('AI reply limit reached for this conversation');
  });

  it('an AI error hands over even with no scenario on, and tells the team', async () => {
    const org = await createOrg(t.c, 'Error Co');
    await newAgent(org);
    const r = await say(org, 'x1', 'Hello?', () => {
      throw new LlmError('invalid_request', false, 'Bad request', 'mock');
    });
    const conv = await convOf(org, r.conversationId);
    expect(conv).toMatchObject({ status: 'human_active', handoffReason: 'The assistant hit an error' });
    await t.c.automation.dispatchPending();
    const alerts = (await t.c.automation.listNotifications(org.scope, null)).filter((n) => n.type === 'conversation.handoff_requested');
    expect(alerts.map((n) => n.link)).toContain(`/conversations/${r.conversationId}`);
  });
});

describe('taking the chat back', () => {
  const dueNow = (org: Org, id: string) =>
    t.c.tenantDb.run(org.orgId, (tx) =>
      tx
        .update(schema.conversations)
        .set({ metadata: sql`${schema.conversations.metadata} || ${JSON.stringify({ reactivateAt: new Date(Date.now() - 60_000).toISOString() })}::jsonb` })
        .where(eq(schema.conversations.id, id)),
    );

  it('once the time is up and nobody from the team replied; later while the team is talking', async () => {
    const org = await createOrg(t.c, 'Back Co');
    const agent = await newAgent(org);
    await configure(org, agent.id, { 'Human Requested': { enabled: true } });

    const quiet = await say(org, 'b1', 'I want to talk to a human');
    expect(await t.c.handoffWatcher.reactivateDue()).toBe(0);
    await dueNow(org, quiet.conversationId);
    expect(await t.c.handoffWatcher.reactivateDue()).toBe(1);
    expect((await convOf(org, quiet.conversationId)).status).toBe('ai_active');
    const resumed = (await t.c.automation.listEvents(org.scope, { contactId: quiet.contactId })).find((e) => e.type === 'conversation.resumed_by_ai');
    expect(resumed).toMatchObject({ actor: 'system', payload: { reason: 'Reactivated after 8 hours (Human Requested)' } });

    const busy = await say(org, 'b2', 'I want to talk to a human');
    await t.c.conversations.humanReply(org.scope, busy.conversationId, await t.c.auth.userIdFromBearer(org.token), 'Maya here, how can I help?');
    await dueNow(org, busy.conversationId);
    expect(await t.c.handoffWatcher.reactivateDue()).toBe(0);
    expect((await convOf(org, busy.conversationId)).status).toBe('human_active');

    // Resume AI by hand clears the plan.
    const resume = await t.app.inject({ method: 'POST', url: `/v1/conversations/${busy.conversationId}/status`, headers: authHeaders(org.token), payload: { action: 'resume' } });
    expect(resume.json().metadata.reactivateAt).toBeUndefined();
  });
});
