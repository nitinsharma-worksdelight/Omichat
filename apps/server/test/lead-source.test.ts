import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

/**
 * Where a lead came from: the widget's first touch (landing page, referrer, UTM tags, ad click ids),
 * stored once per contact; page URLs trimmed to what attribution needs; the API's source; filters.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
const ORIGIN = 'https://brightsmile.example';

/** A widget session; returns a sender that posts a message and waits for the reply. */
async function widget(org: Org) {
  const session = await t.app.inject({ method: 'POST', url: '/widget/v1/sessions', headers: { origin: ORIGIN }, payload: { key: org.webchat.publicKey } });
  const { token } = session.json() as { token: string };
  return async (body: Record<string, unknown>) => {
    const res = await t.app.inject({ method: 'POST', url: '/widget/v1/messages', headers: { authorization: `Bearer ${token}`, origin: ORIGIN }, payload: body });
    expect(res.statusCode).toBeLessThan(300);
    await t.c.queue.drain();
    return res.json() as { conversationId: string };
  };
}

async function contactOf(conversationId: string) {
  const [conv] = await t.c.db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  const [row] = await t.c.db.select().from(schema.contacts).where(eq(schema.contacts.id, conv!.contactId));
  return row!;
}

const FIRST_TOUCH = {
  landingPage: `${ORIGIN}/invisalign?utm_source=google&email=jane@example.com`,
  referrer: 'https://www.google.com/search?q=invisalign+toronto',
  utmSource: 'google',
  utmMedium: 'cpc',
  utmCampaign: 'invisalign-fall',
  gclid: 'abc123',
  at: '2026-09-20T15:00:00.000Z',
};

describe('where a lead came from', () => {
  it('stores the first touch once, without query strings, unknown keys or overlong values', async () => {
    const org = await createOrg(t.c);
    t.llm.setScript([text('Hi!'), text('Sure.')]);
    const send = await widget(org);
    const first = await send({ content: 'Hi, do you do Invisalign?', clientMessageId: 'lead-src-0001', firstTouch: { ...FIRST_TOUCH, bogus: 'x', utmTerm: 'y'.repeat(900) } });
    // A later message with another touch changes nothing: the first touch is the first touch.
    await send({ content: 'Thanks', clientMessageId: 'lead-src-0002', firstTouch: { landingPage: `${ORIGIN}/pricing`, utmSource: 'facebook' } });

    const contact = await contactOf(first.conversationId);
    expect(contact.firstTouch).toEqual({
      landingPage: `${ORIGIN}/invisalign`,
      referrer: 'https://www.google.com/search',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'invisalign-fall',
      gclid: 'abc123',
      at: '2026-09-20T15:00:00.000Z',
    });
    const res = await t.app.inject({ method: 'GET', url: `/v1/contacts/${contact.id}`, headers: authHeaders(org.token) });
    expect(res.json().firstTouch).toMatchObject({ utmSource: 'google', landingPage: `${ORIGIN}/invisalign` });
  });

  it('keeps only UTM and click-id parameters in stored page URLs', async () => {
    const org = await createOrg(t.c);
    t.llm.setScript([text('Hi!')]);
    const send = await widget(org);
    const r = await send({
      content: 'Hello',
      clientMessageId: 'lead-src-0003',
      pageUrl: `${ORIGIN}/book?email=a@b.com&utm_source=google&token=secret&gclid=g1#top`,
    });
    const [message] = await t.c.db.select().from(schema.messages).where(eq(schema.messages.conversationId, r.conversationId));
    expect((message!.metadata as { pageUrl?: string }).pageUrl).toBe(`${ORIGIN}/book?utm_source=google&gclid=g1`);
    const [conv] = await t.c.db.select().from(schema.conversations).where(eq(schema.conversations.id, r.conversationId));
    expect(JSON.stringify(conv!.metadata)).not.toMatch(/secret|a@b\.com/);
  });

  it("takes the API's source; staff-created contacts have no channel, API-created ones have api", async () => {
    const org = await createOrg(t.c);
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: authHeaders(org.token),
      payload: { name: 'forms', scopes: ['conversations:write', 'contacts:read', 'contacts:write'] },
    });
    const apiKey = { authorization: `Bearer ${created.json().key as string}` };

    t.llm.setScript([text('Hello!')]);
    const sent = await t.app.inject({
      method: 'POST',
      url: '/v1/channels/api/messages',
      headers: apiKey,
      payload: { externalUserId: 'crm-77', content: 'Hi', wait: false, source: { utmSource: 'newsletter', utmCampaign: 'october' } },
    });
    await t.c.queue.drain();
    expect((await contactOf(sent.json().conversationId)).firstTouch).toMatchObject({ utmSource: 'newsletter', utmCampaign: 'october' });

    const byStaff = await t.app.inject({ method: 'POST', url: '/v1/contacts', headers: authHeaders(org.token), payload: { firstName: 'Walk', lastName: 'In' } });
    expect(byStaff.json().sourceChannel).toBeNull();
    const byApi = await t.app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: apiKey,
      payload: { firstName: 'Form', email: 'form@example.com', source: { utmSource: 'landing-form' } },
    });
    expect(byApi.json().sourceChannel).toBe('api');
    expect(byApi.json().firstTouch).toMatchObject({ utmSource: 'landing-form' });
  });

  it('a merge keeps the older first touch', async () => {
    const org = await createOrg(t.c);
    const older = await t.c.contacts.create(org.scope, { firstName: 'Old' });
    const newer = await t.c.contacts.create(org.scope, { firstName: 'New' });
    await t.c.contacts.recordFirstTouch(org.scope, older.id, { utmSource: 'google', at: '2026-01-01T00:00:00.000Z' });
    await t.c.contacts.recordFirstTouch(org.scope, newer.id, { utmSource: 'facebook', at: '2026-06-01T00:00:00.000Z' });
    const merged = await t.c.contacts.mergeContacts(org.scope, { duplicateId: older.id, primaryId: newer.id });
    expect(merged.firstTouch).toMatchObject({ utmSource: 'google' });
  });

  it('filters contacts by UTM source and campaign, and lists the values in use', async () => {
    const org = await createOrg(t.c);
    for (const [name, source, campaign] of [
      ['A', 'google', 'fall'],
      ['B', 'google', 'winter'],
      ['C', 'facebook', 'fall'],
    ] as const) {
      const contact = await t.c.contacts.create(org.scope, { firstName: name, email: `${name.toLowerCase()}@example.com` });
      await t.c.contacts.recordFirstTouch(org.scope, contact.id, { utmSource: source, utmCampaign: campaign });
    }
    const names = async (query: string) =>
      ((await t.app.inject({ method: 'GET', url: `/v1/contacts?${query}`, headers: authHeaders(org.token) })).json().items as Array<{ firstName: string }>)
        .map((c) => c.firstName)
        .sort();
    expect(await names('utmSource=google')).toEqual(['A', 'B']);
    expect(await names('utmSource=google&utmCampaign=fall')).toEqual(['A']);
    const options = (await t.app.inject({ method: 'GET', url: '/v1/contacts/source-options', headers: authHeaders(org.token) })).json();
    expect([...options.utmSource].sort()).toEqual(['facebook', 'google']);
    expect([...options.utmCampaign].sort()).toEqual(['fall', 'winter']);
  });
});
