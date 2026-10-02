import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { count, eq } from 'drizzle-orm';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { schema } from '../src/db/client';
import { assertSafeUrl, fetchLimited, guardedLookup, isPublicAddress, safeDispatcher } from '../src/lib/net';
import { authHeaders, createOrg, createTestEnv, type TestEnv } from './helpers';

describe('SSRF guard: which addresses a tenant URL may reach', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // how the URL parser writes [::ffff:127.0.0.1]
    '::ffff:a9fe:a9fe', // 169.254.169.254, the cloud metadata service
    '::ffff:0:7f00:1', // IPv4-translated
    '::7f00:1', // IPv4-compatible
    '64:ff9b::a9fe:a9fe', // NAT64
    '2002:7f00:1::', // 6to4 around 127.0.0.1
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    'not-an-address',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:808:808::1'])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:7f00:1]:6379/',
    'http://[::ffff:0:7f00:1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://2130706433/', // 127.0.0.1 written as one number
    'http://0x7f.1/',
    'http://localhost:4000/',
    'http://169.254.169.254/',
  ])('refuses %s', async (url) => {
    await expect(assertSafeUrl(url, { allowPrivate: false })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses other schemes and URLs with credentials, even when private URLs are allowed', async () => {
    await expect(assertSafeUrl('ftp://example.com/', { allowPrivate: true })).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertSafeUrl('http://user:pw@example.com/', { allowPrivate: true })).rejects.toMatchObject({ statusCode: 400 });
  });

  describe('when connecting (DNS rebinding)', () => {
    let server: Server;
    let port: number;
    beforeAll(async () => {
      server = createServer((_req, res) => res.end('internal secret'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    // A name whose DNS answer turned private after the URL was checked.
    const rebound = (_host: string, cb: (err: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }]);

    it('refuses a name that resolves to a private address at connect time', async () => {
      await expect(undiciFetch(`http://rebind.example:${port}/`, { dispatcher: safeDispatcher(rebound) })).rejects.toMatchObject({
        cause: { name: 'PrivateAddressError' },
      });
    });

    it('the same connection without the guard does reach the server (so the refusal is the guard)', async () => {
      const open = new Agent({
        connect: {
          lookup: ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
            o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as never,
        },
      });
      const res = await undiciFetch(`http://rebind.example:${port}/`, { dispatcher: open });
      expect(await res.text()).toBe('internal secret');
    });

    it('refuses when any resolved address is private', async () => {
      const lookup = guardedLookup((_h, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]));
      const err = await new Promise<Error | null>((r) => lookup('mixed.example', { all: true }, (e) => r(e)));
      expect(err?.name).toBe('PrivateAddressError');
    });

    it('fetchLimited refuses a private address unless allowed', async () => {
      await expect(fetchLimited(`http://127.0.0.1:${port}/`, { timeoutMs: 2_000, maxBytes: 1_000, allowPrivate: false })).rejects.toMatchObject({
        statusCode: 400,
      });
      const ok = await fetchLimited(`http://127.0.0.1:${port}/`, { timeoutMs: 2_000, maxBytes: 1_000, allowPrivate: true });
      expect(ok.body.toString()).toBe('internal secret');
    });
  });

  it('private URLs are off unless ALLOW_PRIVATE_URLS is set, and refused in production', () => {
    expect(loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'pglite://memory' }).ALLOW_PRIVATE_URLS).toBe(false);
    const prod = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      JWT_SECRET: 'x'.repeat(40),
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-4o-mini',
      OPENAI_API_KEY: 'sk-test',
    };
    expect(() => loadEnv(prod)).not.toThrow();
    expect(() => loadEnv({ ...prod, ALLOW_PRIVATE_URLS: 'true' })).toThrow(/ALLOW_PRIVATE_URLS/);
  });

  it('knowledge-base websites and webhooks are refused at the private network', async () => {
    const env = await createTestEnv({ env: { ALLOW_PRIVATE_URLS: 'false' } });
    try {
      const org = await createOrg(env.c);
      const doc = await env.app.inject({
        method: 'POST',
        url: `/v1/knowledge-bases/${org.kb.id}/documents`,
        headers: authHeaders(org.token),
        payload: { type: 'url', url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/' },
      });
      expect(doc.statusCode).toBe(400);
      const hook = await env.app.inject({
        method: 'POST',
        url: '/v1/webhooks',
        headers: authHeaders(org.token),
        payload: { name: 'internal', url: 'http://[::ffff:7f00:1]:6379/' },
      });
      expect(hook.statusCode).toBe(400);
    } finally {
      await env.close();
    }
  });
});

describe('TRUST_PROXY default', () => {
  it('is off: a made-up X-Forwarded-For neither changes the address nor dodges the rate limit', async () => {
    expect(loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'pglite://memory' }).trustProxy).toBe(false);
    const env = await createTestEnv();
    try {
      const org = await createOrg(env.c);
      const statuses: number[] = [];
      for (let i = 0; i < 35; i++) {
        const res = await env.app.inject({
          method: 'POST',
          url: '/widget/v1/sessions',
          remoteAddress: '203.0.113.50',
          headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
          payload: { key: org.webchat.publicKey },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.filter((s) => s === 200)).toHaveLength(30);
      expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    } finally {
      await env.close();
    }
  });
});

describe('public chat API: contact details', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  async function setup(scopes: string[]) {
    const org = await createOrg(t.c);
    const customer = await t.c.contacts.create(org.scope, { firstName: 'Real', lastName: 'Customer', email: `real-${Math.random()}@example.com` });
    const key = await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: authHeaders(org.token), payload: { name: 'forms', scopes } });
    const apiKey = key.json().key as string;
    const post = (payload: Record<string, unknown>, headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }) =>
      t.app.inject({ method: 'POST', url: '/v1/channels/api/messages', headers, payload: { wait: false, ...payload } });
    return { org, customer, post };
  }

  it('an email typed into a form never merges into the customer who owns it: staff review it instead', async () => {
    const { org, customer, post } = await setup(['conversations:write']);
    const res = await post({ externalUserId: 'form-visitor-1', content: 'Hi', contact: { name: 'Someone', email: customer.email } });
    expect(res.statusCode).toBe(202);
    const { contactId } = res.json();
    expect(contactId).not.toBe(customer.id);
    const [visitor] = await t.c.db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(visitor!.mergedIntoId).toBeNull();
    const reviews = await t.app.inject({ method: 'GET', url: `/v1/contacts/${contactId}/merge-candidates`, headers: authHeaders(org.token) });
    expect(reviews.json()).toEqual([expect.objectContaining({ field: 'email', status: 'pending', existing: expect.objectContaining({ id: customer.id }) })]);
  });

  it('`verified` needs the contacts:verify scope; with it the customer is linked and the response names the merged contact', async () => {
    const without = await setup(['conversations:write']);
    const refused = await without.post({ externalUserId: 'signed-in-1', content: 'Hi', contact: { email: without.customer.email, verified: true } });
    expect(refused.statusCode).toBe(403);
    // Nothing was saved for the refused request.
    const [{ n }] = (await t.c.db.select({ n: count() }).from(schema.conversations).where(eq(schema.conversations.organizationId, without.org.orgId))) as [{ n: number }];
    expect(n).toBe(0);

    const allowed = await setup(['conversations:write', 'contacts:verify']);
    const res = await allowed.post({ externalUserId: 'signed-in-2', content: 'Hi', contact: { email: allowed.customer.email, verified: true } });
    expect(res.statusCode).toBe(202);
    expect(res.json().contactId).toBe(allowed.customer.id);

    // A signed-in admin may vouch too.
    const admin = await allowed.post(
      { externalUserId: 'signed-in-3', content: 'Hi', contact: { email: allowed.customer.email, verified: true } },
      authHeaders(allowed.org.token),
    );
    expect(admin.json().contactId).toBe(allowed.customer.id);
  });

  it('a retried message (same messageId) records its consent once', async () => {
    const { org, post } = await setup(['conversations:write']);
    const payload = {
      externalUserId: 'retry-1',
      content: 'Sign me up',
      messageId: 'form-123',
      contact: { name: 'Retry Person', email: `retry-${Math.random()}@example.com`, marketingConsent: { granted: true, text: 'Email me offers' } },
    };
    const first = await post(payload);
    const second = await post(payload);
    expect(second.json().contactId).toBe(first.json().contactId);
    const consents = await t.app.inject({ method: 'GET', url: `/v1/contacts/${first.json().contactId}/consents`, headers: authHeaders(org.token) });
    const history = (consents.json() as { history?: unknown[] }).history ?? consents.json();
    expect(history).toHaveLength(1);
  });
});

describe('verified details that belong to two different people', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('merge into neither: both go to staff review', async () => {
    const org = await createOrg(t.c);
    const bob = await t.c.contacts.create(org.scope, { firstName: 'Bob', email: `bob-${Math.random()}@example.com` });
    const carol = await t.c.contacts.create(org.scope, { firstName: 'Carol', phone: '+14165550123' });
    const visitor = await t.c.contacts.create(org.scope, { firstName: 'Visitor' });
    const result = await t.c.contacts.captureDetails(org.scope, visitor.id, { email: bob.email!, phone: '+14165550123' }, 'contact', { trust: 'verified' });
    expect(result.contactId).toBe(visitor.id);
    const rows = await t.c.db.select({ id: schema.contacts.id, mergedIntoId: schema.contacts.mergedIntoId }).from(schema.contacts).where(eq(schema.contacts.organizationId, org.orgId));
    expect(rows.every((r) => r.mergedIntoId === null)).toBe(true);
    const reviews = await t.app.inject({ method: 'GET', url: `/v1/contacts/${visitor.id}/merge-candidates`, headers: authHeaders(org.token) });
    expect((reviews.json() as Array<{ field: string; existing: { id: string } }>).map((r) => [r.field, r.existing.id]).sort()).toEqual(
      [
        ['email', bob.id],
        ['phone', carol.id],
      ].sort(),
    );
  });

  it('still merge once when both belong to the same person', async () => {
    const org = await createOrg(t.c);
    const dana = await t.c.contacts.create(org.scope, { firstName: 'Dana', email: `dana-${Math.random()}@example.com`, phone: '+14165550188' });
    const visitor = await t.c.contacts.create(org.scope, { firstName: 'Visitor' });
    const result = await t.c.contacts.captureDetails(org.scope, visitor.id, { email: dana.email!, phone: '+14165550188' }, 'contact', { trust: 'verified' });
    expect(result.contactId).toBe(dana.id);
    const events = await t.c.automation.listEvents(org.scope, { contactId: dana.id });
    expect(events.filter((e) => e.type === 'contact.merged')).toHaveLength(1);
  });
});

describe("writes can't point at another organization's records", () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('appointments, tags, notes and tasks refuse a contact from another organization', async () => {
    const mine = await createOrg(t.c);
    const theirs = await createOrg(t.c);
    const victim = await t.c.contacts.create(theirs.scope, { firstName: 'Victim' });
    const headers = authHeaders(mine.token);

    const booking = await t.app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers,
      payload: { calendarId: mine.calendar.id, contactId: victim.id, start: '2026-09-29T10:00' },
    });
    expect(booking.statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/v1/contacts/${victim.id}/tags`, headers, payload: { tags: ['vip'] } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/v1/contacts/${victim.id}/notes`, headers, payload: { body: 'hello' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { title: 'Call', contactId: victim.id } })).statusCode).toBe(404);

    const rows = async (table: typeof schema.appointments | typeof schema.contactTags | typeof schema.contactNotes | typeof schema.tasks) =>
      (await t.c.db.select({ n: count() }).from(table).where(eq(table.contactId, victim.id)))[0]!.n;
    expect(await rows(schema.appointments)).toBe(0);
    expect(await rows(schema.contactTags)).toBe(0);
    expect(await rows(schema.contactNotes)).toBe(0);
    expect(await rows(schema.tasks)).toBe(0);
  });
});
