import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startersToOffer } from '../../widget/src/starters';
import { schema } from '../src/db/client';
import type { BotConfig } from '../src/modules/bots/config';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

/**
 * Conversation starters: quick options a bot's website chat offers under its greeting until the visitor writes.
 * Admins keep them in the bot's configuration; the widget gets the enabled ones; a click sends the starter's message,
 * and a "talk to the team" starter also hands the chat to the team without asking the AI.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
type Starter = { id: string; label: string; message: string; action: 'message' | 'handoff'; enabled: boolean; order: number };
type ErrorBody = { error: { message: string; details: Array<{ path: string; message: string }> } };

const BOOK = { label: 'Book an appointment', message: "I'd like to book an appointment." };
// Deliberately without any of the default handoff keywords: only the starter itself can hand off.
const TEAM = { label: 'Talk to the team', message: "I'd like to talk to someone on your team.", action: 'handoff' as const };

const setStarters = (org: Org, starters: unknown, token = org.token) =>
  t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(token), payload: { config: { conversationStarters: starters } } });

async function save(org: Org, starters: unknown): Promise<Starter[]> {
  const res = await setStarters(org, starters);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { config: { conversationStarters: Starter[] } }).config.conversationStarters;
}

async function refused(org: Org, starters: unknown) {
  const res = await setStarters(org, starters);
  expect(res.statusCode, res.body).toBe(400);
  return (res.json() as ErrorBody).error.details;
}

async function offered(org: Org) {
  const res = await t.app.inject({ method: 'GET', url: `/widget/v1/config?key=${org.webchat.publicKey}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { starters: unknown[] }).starters;
}

/** A new visitor's chat session. */
async function visit(org: Org) {
  const res = await t.app.inject({ method: 'POST', url: '/widget/v1/sessions', payload: { key: org.webchat.publicKey } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { token: string }).token;
}

/** What a click sends: the starter's message and id (or, for a typed message, just the text). */
async function send(token: string, content: string, starterId?: string, clientMessageId: string = crypto.randomUUID()) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/widget/v1/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { content, clientMessageId, ...(starterId ? { starterId } : {}) },
  });
  expect([200, 201], res.body).toContain(res.statusCode);
  await t.c.queue.drain();
  return { status: res.statusCode, ...(res.json() as { conversationId: string; message: { id: string; content: string } }) };
}

async function inbound(conversationId: string) {
  return t.c.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, 'inbound')));
}

async function member(org: Org, role: 'agent' | 'admin') {
  const email = `${role}-${Math.random().toString(36).slice(2)}@example.com`;
  const created = await t.app.inject({ method: 'POST', url: '/v1/members', headers: authHeaders(org.token), payload: { email, role, password: 'member-password-1' } });
  expect(created.statusCode, created.body).toBeLessThan(300);
  return (await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'member-password-1' } })).json().token as string;
}

describe('conversation starters in the bot configuration', () => {
  it('an existing bot has none, including one saved before starters existed', async () => {
    const org = await createOrg(t.c, 'Starterless Clinic');
    // A configuration stored before this feature has no such section at all.
    const [row] = await t.c.db.select({ config: schema.bots.config }).from(schema.bots).where(eq(schema.bots.id, org.bot.id));
    const older: Partial<BotConfig> = structuredClone(row!.config);
    delete older.conversationStarters;
    await t.c.db.update(schema.bots).set({ config: older as BotConfig }).where(eq(schema.bots.id, org.bot.id));

    const bot = await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token) });
    expect(bot.json().config.conversationStarters).toEqual([]);
    expect(await offered(org)).toEqual([]);
  });

  it('admins add, edit, reorder, hide and delete them; ids stay put and the order is renumbered', async () => {
    const org = await createOrg(t.c, 'Starter Clinic');
    const added = await save(org, [BOOK, { label: '  Reschedule\n my   visit ' }, TEAM]);
    expect(added).toEqual([
      { id: expect.any(String), ...BOOK, action: 'message', enabled: true, order: 0 },
      // One line; an empty message means the label is sent.
      { id: expect.any(String), label: 'Reschedule my visit', message: '', action: 'message', enabled: true, order: 1 },
      { id: expect.any(String), ...TEAM, enabled: true, order: 2 },
    ]);
    const [book, reschedule, team] = added;
    expect(new Set(added.map((s) => s.id)).size).toBe(3);

    // Edit one, hide one, and move them: `order` decides, whatever order they're listed in.
    const edited = await save(org, [
      { ...book, label: 'Book a visit', order: 2 },
      { ...reschedule, enabled: false, order: 0 },
      { ...team, order: 1 },
    ]);
    expect(edited.map((s) => [s.id, s.label, s.enabled, s.order])).toEqual([
      [reschedule!.id, 'Reschedule my visit', false, 0],
      [team!.id, TEAM.label, true, 1],
      [book!.id, 'Book a visit', true, 2],
    ]);

    // Deleting is saving the list without it; the rest keep their ids and close the gap.
    const remaining = await save(org, edited.filter((s) => s.id !== team!.id));
    expect(remaining.map((s) => [s.id, s.order])).toEqual([
      [reschedule!.id, 0],
      [book!.id, 1],
    ]);
    // Saved like the rest of the bot: each change is a new version.
    const bot = await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token) });
    expect(bot.json().version).toBe(org.bot.version + 3);
  });

  it('refuses invalid starters, naming the one at fault', async () => {
    const org = await createOrg(t.c, 'Strict Starter Clinic');
    expect((await refused(org, [BOOK, { label: '   ' }])).map((d) => d.path)).toContain('conversationStarters.1.label');
    expect((await refused(org, [{ label: 'x'.repeat(61) }])).map((d) => d.path)).toContain('conversationStarters.0.label');
    expect((await refused(org, [{ ...BOOK, message: 'x'.repeat(501) }])).map((d) => d.path)).toContain('conversationStarters.0.message');
    expect((await refused(org, [{ ...BOOK, action: 'book' }])).map((d) => d.path)).toContain('conversationStarters.0.action');
    const eleven = Array.from({ length: 11 }, (_, i) => ({ label: `Option ${i + 1}` }));
    expect((await refused(org, eleven)).map((d) => d.path)).toContain('conversationStarters');
    expect((await refused(org, [BOOK, { label: 'BOOK AN APPOINTMENT ' }])).map((d) => d.message)).toContain(
      'conversationStarters: duplicate label "BOOK AN APPOINTMENT"',
    );
    // Nothing was saved along the way.
    expect(await offered(org)).toEqual([]);
  });

  it('"talk to the team" needs Human handoff on, unless it is hidden', async () => {
    const org = await createOrg(t.c, 'No Handoff Clinic');
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/bots/${org.bot.id}`,
      headers: authHeaders(org.token),
      payload: { config: { handoff: { enabled: false }, conversationStarters: [BOOK, TEAM] } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.details.map((d) => d.message)).toContain(
      'conversationStarters: "Talk to the team" hands the chat to your team, but Human handoff is off',
    );
    const hidden = await t.app.inject({
      method: 'PATCH',
      url: `/v1/bots/${org.bot.id}`,
      headers: authHeaders(org.token),
      payload: { config: { handoff: { enabled: false }, conversationStarters: [BOOK, { ...TEAM, enabled: false }] } },
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
  });

  it('only admins can change them', async () => {
    const org = await createOrg(t.c, 'Team Starter Clinic');
    const agent = await member(org, 'agent');
    expect((await setStarters(org, [BOOK], agent)).statusCode).toBe(403);
    expect((await setStarters(org, [BOOK], await member(org, 'admin'))).statusCode).toBe(200);
  });
});

describe('what the website chat gets', () => {
  it('the enabled starters, in order, each with exactly the text a click sends, and nothing internal', async () => {
    const org = await createOrg(t.c, 'Widget Starter Clinic');
    const [book, hours, , team] = await save(org, [BOOK, { label: 'Opening hours' }, { label: 'Hidden', enabled: false }, TEAM]);
    expect(await offered(org)).toEqual([
      { id: book!.id, label: BOOK.label, message: BOOK.message },
      { id: hours!.id, label: 'Opening hours', message: 'Opening hours' },
      { id: team!.id, label: TEAM.label, message: TEAM.message },
    ]);

    // The playground offers the same, to try them before visitors do.
    const pg = await t.app.inject({ method: 'POST', url: `/v1/bots/${org.bot.id}/playground`, headers: authHeaders(org.token) });
    expect(pg.json().starters).toEqual(await offered(org));

    // Another organization's website chat never shows them.
    const other = await createOrg(t.c, 'Other Widget Clinic');
    expect(await offered(other)).toEqual([]);
  });
});

describe('clicking a starter', () => {
  it('sends its message as the visitor’s, and the AI answers it as usual', async () => {
    const org = await createOrg(t.c, 'Click Clinic');
    const [book] = await save(org, [BOOK, TEAM]);
    t.llm.setScript([text('Happy to help! Which day suits you?')]);
    const sent = await send(await visit(org), BOOK.message, book!.id);

    expect(sent.message.content).toBe(BOOK.message);
    const [message] = await inbound(sent.conversationId);
    expect(message!.metadata).toMatchObject({ starterId: book!.id });
    expect(t.llm.requests).toHaveLength(1);
    const conv = await t.c.conversations.get(org.scope, sent.conversationId);
    expect(conv.status).toBe('ai_active');
    const messages = await t.c.conversations.messages(org.scope, sent.conversationId);
    expect(messages.at(-1)!.content).toBe('Happy to help! Which day suits you?');
  });

  it('"talk to the team" hands the chat to the team without asking the AI', async () => {
    const org = await createOrg(t.c, 'Handoff Click Clinic');
    const [, team] = await save(org, [BOOK, TEAM]);
    t.llm.setScript([]);
    const sent = await send(await visit(org), TEAM.message, team!.id);

    expect(t.llm.requests).toHaveLength(0);
    const conv = await t.c.conversations.get(org.scope, sent.conversationId);
    expect(conv).toMatchObject({ status: 'human_active', handoffReason: 'Customer chose "Talk to the team"' });
    const messages = await t.c.conversations.messages(org.scope, sent.conversationId);
    expect(messages.map((m) => m.content)).toEqual([TEAM.message, expect.stringMatching(/connecting you with a member of our team/)]);
    await t.c.automation.dispatchPending();
    expect((await t.c.automation.listNotifications(org.scope, null))[0]!.type).toBe('conversation.handoff_requested');
  });

  it('a starter that is hidden, deleted or another bot’s is just a message', async () => {
    const org = await createOrg(t.c, 'Stale Starter Clinic');
    const other = await createOrg(t.c, 'Other Starter Clinic');
    const [otherTeam] = await save(other, [TEAM]);
    const [deleted] = await save(org, [TEAM]);
    const [hidden] = await save(org, [{ ...TEAM, label: 'Talk to us', enabled: false }]);

    for (const starterId of [hidden!.id, deleted!.id, otherTeam!.id]) {
      t.llm.setScript([text('Sure, how can I help?')]);
      const sent = await send(await visit(org), TEAM.message, starterId);
      expect(t.llm.requests).toHaveLength(1);
      expect((await t.c.conversations.get(org.scope, sent.conversationId)).status).toBe('ai_active');
    }
  });

  it('a double click keeps one message and gets one reply', async () => {
    const org = await createOrg(t.c, 'Double Click Clinic');
    const [book] = await save(org, [BOOK]);
    const token = await visit(org);
    const clientMessageId = crypto.randomUUID();
    t.llm.setScript([text('Sure! Which day suits you?')]);
    const first = await send(token, BOOK.message, book!.id, clientMessageId);
    const again = await send(token, BOOK.message, book!.id, clientMessageId);

    expect(first.status).toBe(201);
    expect(again).toMatchObject({ status: 200, conversationId: first.conversationId, message: { id: first.message.id } });
    expect(await inbound(first.conversationId)).toHaveLength(1);
    expect(t.llm.requests).toHaveLength(1);
  });

  it('refuses a starter id that isn’t an id', async () => {
    const org = await createOrg(t.c, 'Odd Starter Clinic');
    const token = await visit(org);
    const res = await t.app.inject({
      method: 'POST',
      url: '/widget/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'Hello', starterId: '<script>' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('which starters the widget shows', () => {
  const book = { id: 'a1', label: 'Book an appointment', message: "I'd like to book an appointment." };
  const team = { id: 'b2', label: 'Talk to the team', message: 'Talk to the team' };

  it('the ones offered, in order, until the visitor has written', () => {
    expect(startersToOffer([book, team], [])).toEqual([book, team]);
    expect(startersToOffer([book, team], [{ role: 'assistant' }])).toEqual([book, team]);
    expect(startersToOffer([book, team], [{ role: 'assistant' }, { role: 'user' }])).toEqual([]);
  });

  it('skips anything malformed rather than showing it half-working', () => {
    expect(startersToOffer(undefined, [])).toEqual([]);
    expect(startersToOffer({ book }, [])).toEqual([]);
    expect(
      startersToOffer(
        [null, 'Book', { id: 'c3', label: '  ', message: 'x' }, { id: 'd4', label: 'Hours', message: '' }, { label: 'No id', message: 'x' }, book, { ...book, label: 'Copy' }, team],
        [],
      ),
    ).toEqual([book, team]);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, label: `Option ${i}`, message: `Option ${i}` }));
    expect(startersToOffer(many, [])).toHaveLength(10);
  });
});
