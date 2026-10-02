import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { loadEnv } from '../src/config/env';
import { normalizeIp } from '../src/lib/ip';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

/**
 * The website chat records the visitor's IP address on their conversation, as the server sees it (never an address
 * the visitor sends, and through TRUST_PROXY's proxies only), without creating anything when the chat opens, and
 * without showing it to the visitor or the AI. Playground chats record none.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;

/** New organizations don't record addresses until they turn it on (Settings → Organization). */
async function recordingOrg(c: TestEnv['c'], name: string) {
  const org = await createOrg(c, name);
  await c.tenancy.updateOrganization(org.orgId, { settings: { recordVisitorIp: true } });
  return org;
}
type Session = { token: string; visitorId: string; conversationId: string | null };

async function openChat(env: TestEnv, org: Org, from: string, opts: { visitorId?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
  const res = await env.app.inject({
    method: 'POST',
    url: '/widget/v1/sessions',
    remoteAddress: from,
    headers: opts.headers ?? {},
    payload: { key: org.webchat.publicKey, ...(opts.visitorId ? { visitorId: opts.visitorId } : {}), ...opts.body },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { session: res.json() as Session, raw: res.body };
}

async function send(env: TestEnv, token: string, from: string, headers: Record<string, string> = {}) {
  env.llm.setScript([text('Hi! How can I help?')]);
  const res = await env.app.inject({ method: 'POST', url: '/widget/v1/messages', remoteAddress: from, headers: { authorization: `Bearer ${token}`, ...headers }, payload: { content: 'Hello' } });
  expect(res.statusCode, res.body).toBe(201);
  await env.c.queue.drain();
  return (res.json() as { conversationId: string }).conversationId;
}

async function conversation(env: TestEnv, id: string) {
  const [row] = await env.c.db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
  return row!;
}

const recordsOf = async (env: TestEnv, org: Org) => {
  const [contacts] = await env.c.db.select({ n: count() }).from(schema.contacts).where(eq(schema.contacts.organizationId, org.orgId));
  const [conversations] = await env.c.db.select({ n: count() }).from(schema.conversations).where(eq(schema.conversations.organizationId, org.orgId));
  return { contacts: contacts!.n, conversations: conversations!.n };
};

describe("the visitor's IP address", () => {
  it('is saved on the conversation the first message creates; opening the chat creates nothing', async () => {
    const org = await recordingOrg(t.c, 'IP Clinic');
    const before = await recordsOf(t, org);
    const { session, raw } = await openChat(t, org, '203.0.113.7');
    expect(await recordsOf(t, org)).toEqual(before);
    expect(raw).not.toContain('203.0.113.7');

    const id = await send(t, session.token, '203.0.113.7');
    const conv = await conversation(t, id);
    expect(conv.metadata).toMatchObject({ visitorIp: '203.0.113.7', visitorIpAt: expect.any(String) });
    // Only on the conversation: not on the message, and never to the AI.
    const [message] = await t.c.db.select().from(schema.messages).where(and(eq(schema.messages.conversationId, id), eq(schema.messages.direction, 'inbound')));
    expect(JSON.stringify(message!.metadata)).not.toContain('203.0.113.7');
    expect(JSON.stringify(t.llm.requests)).not.toContain('203.0.113.7');
    // Nor in what the widget reads back.
    const history = await t.app.inject({ method: 'GET', url: '/widget/v1/messages', headers: { authorization: `Bearer ${session.token}` } });
    expect(history.body).not.toContain('203.0.113.7');

    // The organization's staff can see it; another organization can't reach the conversation at all.
    const own = await t.app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: authHeaders(org.token) });
    expect(own.json()).toMatchObject({ metadata: { visitorIp: '203.0.113.7' } });
    const other = await createOrg(t.c, 'Other IP Clinic');
    expect((await t.app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: authHeaders(other.token) })).statusCode).toBe(404);
  });

  it('is updated when a returning visitor opens the chat from a new address, and left alone when unchanged', async () => {
    const org = await recordingOrg(t.c, 'Returning IP Clinic');
    const first = await openChat(t, org, '203.0.113.7');
    const id = await send(t, first.session.token, '203.0.113.7');
    const seenFirst = (await conversation(t, id)).metadata.visitorIpAt;

    const again = await openChat(t, org, '::ffff:198.51.100.23', { visitorId: first.session.visitorId });
    expect(again.session.conversationId).toBe(id);
    const moved = await conversation(t, id);
    expect(moved.metadata).toMatchObject({ visitorIp: '198.51.100.23' });
    expect(moved.metadata.visitorIpAt).not.toBe(seenFirst);

    await openChat(t, org, '198.51.100.23', { visitorId: first.session.visitorId });
    const unchanged = await conversation(t, id);
    expect(unchanged.metadata.visitorIpAt).toBe(moved.metadata.visitorIpAt);
    expect(unchanged.updatedAt.getTime()).toBe(moved.updatedAt.getTime());
    // The page and browser the conversation started with are kept.
    expect(unchanged.metadata).toHaveProperty('userAgent');
  });

  it('ignores any address the visitor sends', async () => {
    const org = await recordingOrg(t.c, 'Spoof IP Clinic');
    const fake = { ip: '1.1.1.1', visitorIp: '1.1.1.1' };
    const { session } = await openChat(t, org, '203.0.113.50', { body: fake, headers: { 'x-real-ip': '1.1.1.1', 'client-ip': '1.1.1.1' } });
    const id = await send(t, session.token, '203.0.113.50', { 'x-real-ip': '1.1.1.1' });
    expect((await conversation(t, id)).metadata).toMatchObject({ visitorIp: '203.0.113.50' });
  });

  it('is not recorded for playground chats (that would be the team member testing)', async () => {
    const org = await recordingOrg(t.c, 'Playground IP Clinic');
    const pg = (await t.app.inject({ method: 'POST', url: `/v1/bots/${org.bot.id}/playground`, headers: authHeaders(org.token) })).json() as { token: string };
    const id = await send(t, pg.token, '203.0.113.99');
    expect((await conversation(t, id)).metadata).not.toHaveProperty('visitorIp');
  });

  it('is cleaned up, and unusable values are skipped', () => {
    expect(normalizeIp('::ffff:192.0.2.5')).toBe('192.0.2.5');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normalizeIp(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('unknown')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});

describe('TRUST_PROXY', () => {
  // A visitor behind the platform's proxy (10.0.0.5), who also sent a made-up X-Forwarded-For entry (6.6.6.6).
  const forwarded = { 'x-forwarded-for': '6.6.6.6, 198.51.100.9' };

  it("set to the platform's proxy addresses, only the address they saw counts", async () => {
    const env = await createTestEnv({ env: { TRUST_PROXY: 'uniquelocal' } });
    try {
      const org = await recordingOrg(env.c, 'Proxy IP Clinic');
      const { session } = await openChat(env, org, '10.0.0.5', { headers: forwarded });
      const id = await send(env, session.token, '10.0.0.5', forwarded);
      expect((await conversation(env, id)).metadata).toMatchObject({ visitorIp: '198.51.100.9' });
    } finally {
      await env.close();
    }
  });

  it('refuses a number of hops, which could not tell a proxy from a visitor', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', TRUST_PROXY: '2' })).toThrow(/TRUST_PROXY/);
  });

  it('set to false, forwarded addresses are ignored', async () => {
    const env = await createTestEnv({ env: { TRUST_PROXY: 'false' } });
    try {
      const org = await recordingOrg(env.c, 'No Proxy IP Clinic');
      const { session } = await openChat(env, org, '10.0.0.5', { headers: forwarded });
      const id = await send(env, session.token, '10.0.0.5', forwarded);
      expect((await conversation(env, id)).metadata).toMatchObject({ visitorIp: '10.0.0.5' });
    } finally {
      await env.close();
    }
  });
});

describe('who sees the address (Q4)', () => {
  const login = async (org: Org, role: 'viewer' | 'agent' | 'admin') => {
    const email = `${role}-${Math.random().toString(36).slice(2)}@example.com`;
    await t.c.tenancy.addMember(org.orgId, { email, role, password: 'password-123' });
    return (await t.c.auth.login({ email, password: 'password-123' })).token;
  };
  const ipIn = (body: string) => body.includes('198.51.100.9');

  it('admins and owners only: not viewers, agents or API keys, in the conversation or the list', async () => {
    const org = await recordingOrg(t.c, 'Who Sees IP Clinic');
    const { session } = await openChat(t, org, '198.51.100.9');
    const id = await send(t, session.token, '198.51.100.9');
    const key = (await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: authHeaders(org.token), payload: { name: 'reader', scopes: ['conversations:read'] } })).json().key as string;

    const as = async (headers: Record<string, string>) => {
      const one = await t.app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers });
      const list = await t.app.inject({ method: 'GET', url: '/v1/conversations', headers });
      expect(one.statusCode).toBe(200);
      expect(list.statusCode).toBe(200);
      return { one: ipIn(one.body), list: ipIn(list.body) };
    };
    expect(await as(authHeaders(org.token))).toEqual({ one: true, list: true }); // the owner
    expect(await as(authHeaders(await login(org, 'admin'), org.orgId))).toEqual({ one: true, list: true });
    expect(await as(authHeaders(await login(org, 'agent'), org.orgId))).toEqual({ one: false, list: false });
    expect(await as(authHeaders(await login(org, 'viewer'), org.orgId))).toEqual({ one: false, list: false });
    expect(await as({ authorization: `Bearer ${key}` })).toEqual({ one: false, list: false });

    // Taking over or assigning answers with the conversation too: still without the address for an agent.
    const agent = await login(org, 'agent');
    const takeover = await t.app.inject({ method: 'POST', url: `/v1/conversations/${id}/status`, headers: authHeaders(agent, org.orgId), payload: { action: 'takeover' } });
    expect(takeover.statusCode).toBe(200);
    expect(ipIn(takeover.body)).toBe(false);
    const assigned = await t.app.inject({ method: 'POST', url: `/v1/conversations/${id}/assign`, headers: authHeaders(agent, org.orgId), payload: { userId: null } });
    expect(assigned.statusCode).toBe(200);
    expect(ipIn(assigned.body)).toBe(false);
  });

  it('is not recorded or shown while the setting is off, which new organizations start with', async () => {
    const org = await createOrg(t.c, 'New Org IP Clinic');
    expect((await t.app.inject({ method: 'GET', url: '/v1/org', headers: authHeaders(org.token) })).json().settings.recordVisitorIp).toBe(false);
    const { session } = await openChat(t, org, '198.51.100.9');
    const id = await send(t, session.token, '198.51.100.9');
    expect((await conversation(t, id)).metadata).not.toHaveProperty('visitorIp');

    // Turned on: recorded from the next session. Turned off again: the stored one isn't shown, even to the owner.
    expect((await t.app.inject({ method: 'PATCH', url: '/v1/org', headers: authHeaders(org.token), payload: { settings: { recordVisitorIp: true } } })).statusCode).toBe(200);
    await openChat(t, org, '198.51.100.9', { visitorId: session.visitorId });
    expect((await conversation(t, id)).metadata).toMatchObject({ visitorIp: '198.51.100.9' });
    await t.app.inject({ method: 'PATCH', url: '/v1/org', headers: authHeaders(org.token), payload: { settings: { recordVisitorIp: false } } });
    expect(ipIn((await t.app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: authHeaders(org.token) })).body)).toBe(false);
  });

  it('keeps recording for organizations from before the setting', async () => {
    const org = await createOrg(t.c, 'Older Org IP Clinic');
    // Saved before the setting existed: no recordVisitorIp at all.
    const [row] = await t.c.db.select().from(schema.organizations).where(eq(schema.organizations.id, org.orgId));
    const { recordVisitorIp: _, ...settings } = row!.settings;
    await t.c.db.update(schema.organizations).set({ settings }).where(eq(schema.organizations.id, org.orgId));
    expect((await t.app.inject({ method: 'GET', url: '/v1/org', headers: authHeaders(org.token) })).json().settings.recordVisitorIp).toBe(true);
    const { session } = await openChat(t, org, '198.51.100.9');
    const id = await send(t, session.token, '198.51.100.9');
    expect((await conversation(t, id)).metadata).toMatchObject({ visitorIp: '198.51.100.9' });
  });
});
