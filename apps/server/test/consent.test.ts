import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { isPlainNo } from '../src/modules/leads/attribution';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/**
 * Marketing opt-in with proof: the server posts the bot's exact wording, the AI records the answer only
 * after the customer gave one (their message is the evidence), withdrawals are always accepted, and
 * staff and integrations can record consent too. History moves with merges and reaches webhooks.
 */

const OPT_IN = 'Would you like occasional offers from Acme Clinic by email or text? You can opt out anytime.';

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;

async function clinic(optIn = OPT_IN): Promise<Org> {
  const org = await createOrg(t.c, 'Consent Clinic');
  await t.c.bots.update(org.scope, org.bot.id, { config: { leadCapture: { enabled: true, marketingOptIn: optIn } } });
  return org;
}

async function send(org: Org, content: string, visitor: string) {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

const consentRows = (contactId: string) =>
  t.c.db.select().from(schema.contactConsents).where(eq(schema.contactConsents.contactId, contactId)).orderBy(desc(schema.contactConsents.createdAt));
const contactRow = async (id: string) => (await t.c.db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0]!;
const messagesOf = (conversationId: string) =>
  t.c.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(asc(schema.messages.createdAt));
const toolStatuses = async (conversationId: string, name: string) =>
  (
    await t.c.db
      .select({ status: schema.toolInvocations.status })
      .from(schema.toolInvocations)
      .where(and(eq(schema.toolInvocations.conversationId, conversationId), eq(schema.toolInvocations.toolName, name)))
      .orderBy(asc(schema.toolInvocations.createdAt))
  ).map((r) => r.status);

describe('marketing opt-in in the chat', () => {
  it('posts the exact wording as its own message after the reply', async () => {
    const org = await clinic();
    t.llm.setScript([
      tools({ name: 'save_contact_details', input: { name: 'Jane Doe', email: 'jane@example.com' } }),
      tools({ name: 'ask_marketing_consent', input: {} }),
      text('Thanks, Jane! One more thing:'),
    ]);
    const r = await send(org, "I'm Jane Doe, jane@example.com", 'jane');
    expect(t.llm.requests[0]!.tools.map((x) => x.name)).toEqual(expect.arrayContaining(['ask_marketing_consent', 'record_marketing_consent']));
    expect(t.llm.requests[0]!.messages.at(-1)!.content.map((b) => (b.type === 'text' ? b.text : '')).join('')).toContain('marketing consent: not asked yet');

    const messages = await messagesOf(r.conversationId);
    expect(messages.map((m) => [m.senderType, m.content])).toEqual([
      ['contact', "I'm Jane Doe, jane@example.com"],
      ['ai', 'Thanks, Jane! One more thing:'],
      ['ai', OPT_IN],
    ]);
    expect(messages[2]!.metadata).toMatchObject({ consentRequest: { purpose: 'marketing' } });
  });

  it('records an answer only after the question was posted and answered, with the exact text and evidence', async () => {
    const org = await clinic();
    // Nothing asked yet: refused.
    t.llm.setScript([tools({ name: 'record_marketing_consent', input: { granted: true } }), text('OK.')]);
    const first = await send(org, 'Sure, send me offers', 'sam');
    // Asked in this turn, but the customer hasn't answered: refused (the question is only posted after the reply).
    t.llm.setScript([tools({ name: 'ask_marketing_consent', input: {} }), tools({ name: 'record_marketing_consent', input: { granted: true } }), text('Here you go:')]);
    await send(org, 'What offers do you have?', 'sam');
    expect(await toolStatuses(first.conversationId, 'record_marketing_consent')).toEqual(['error', 'error']);
    expect(await consentRows(first.contactId)).toHaveLength(0);

    // The customer answers the posted question: recorded.
    t.llm.setScript([tools({ name: 'record_marketing_consent', input: { granted: true } }), text('Great, you are on the list.')]);
    const answer = await send(org, 'Yes please!', 'sam');
    const [row] = await consentRows(answer.contactId);
    expect(row).toMatchObject({ purpose: 'marketing', granted: true, text: OPT_IN, source: 'chat', conversationId: answer.conversationId });
    expect(row!.textVersion).toMatch(/^[0-9a-f]{12}$/);
    const messages = await messagesOf(answer.conversationId);
    expect(messages.find((m) => m.id === row!.evidenceMessageId)?.content).toBe('Yes please!');
    expect(messages.find((m) => m.id === row!.requestMessageId)?.content).toBe(OPT_IN);
    expect((await contactRow(answer.contactId)).consent).toMatchObject({ marketing: { granted: true, source: 'chat' } });

    // Answered already: not asked again, and the next turn knows.
    t.llm.setScript([tools({ name: 'ask_marketing_consent', input: {} }), text('Anything else?')]);
    await send(org, 'Thanks', 'sam');
    expect(await toolStatuses(answer.conversationId, 'ask_marketing_consent')).toEqual(['success', 'error']);
    expect(JSON.stringify(t.llm.requests[0]!.messages.at(-1))).toContain('marketing consent: yes');
  });

  it('stores a decline, and refuses a yes when the reply is a plain no', async () => {
    const org = await clinic();
    t.llm.setScript([tools({ name: 'ask_marketing_consent', input: {} }), text('Also:')]);
    await send(org, 'My email is lee@example.com', 'lee');
    t.llm.setScript([
      tools({ name: 'record_marketing_consent', input: { granted: true } }),
      tools({ name: 'record_marketing_consent', input: { granted: false } }),
      text('No problem.'),
    ]);
    const r = await send(org, 'No thanks', 'lee');
    expect(await toolStatuses(r.conversationId, 'record_marketing_consent')).toEqual(['error', 'success']);
    const rows = await consentRows(r.contactId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ granted: false, text: OPT_IN });
  });

  it('treats only a reply that is nothing but a no as a plain no', () => {
    for (const no of ['No thanks', 'no thank you!', 'Nope.', 'not interested, thanks', 'नहीं', 'nahi']) expect(isPlainNo(no), no).toBe(true);
    for (const yes of ['No problem, sign me up!', 'Yes please', 'no worries, yes', 'sure', 'Why not']) expect(isPlainNo(yes), yes).toBe(false);
  });

  it("accepts a withdrawal without a question, with the customer's message as evidence", async () => {
    const org = await clinic();
    t.llm.setScript([tools({ name: 'record_marketing_consent', input: { granted: false } }), text('Done — no more offers.')]);
    const r = await send(org, 'Please stop sending me marketing emails', 'pat');
    const [row] = await consentRows(r.contactId);
    expect(row).toMatchObject({ granted: false, text: null, requestMessageId: null, source: 'chat' });
    expect((await messagesOf(r.conversationId)).find((m) => m.id === row!.evidenceMessageId)?.content).toBe('Please stop sending me marketing emails');
  });

  it('offers no consent tools when the bot has no opt-in question', async () => {
    const org = await clinic('');
    t.llm.setScript([text('Hi!')]);
    await send(org, 'Hello', 'nobody');
    expect(t.llm.requests[0]!.tools.map((x) => x.name)).not.toEqual(expect.arrayContaining(['ask_marketing_consent']));
    expect(t.llm.requests[0]!.tools.map((x) => x.name)).not.toContain('record_marketing_consent');
  });
});

describe('consent from staff and integrations', () => {
  it('staff and API keys record or withdraw; history is kept; a merge moves it', async () => {
    const org = await clinic();
    const key = await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: authHeaders(org.token), payload: { name: 'forms', scopes: ['contacts:read', 'contacts:write'] } });
    const apiKey = { authorization: `Bearer ${key.json().key as string}` };
    const ana = await t.c.contacts.create(org.scope, { firstName: 'Ana', email: 'ana@example.com' });
    const post = (headers: Record<string, string>, payload: unknown) => t.app.inject({ method: 'POST', url: `/v1/contacts/${ana.id}/consents`, headers, payload: payload as object });

    expect((await post(authHeaders(org.token), { purpose: 'marketing', granted: true })).statusCode).toBe(400); // staff must say why
    const staff = await post(authHeaders(org.token), { purpose: 'marketing', granted: true, note: 'Agreed by phone on 5 October' });
    expect(staff.statusCode).toBe(201);
    expect(staff.json()).toMatchObject({ granted: true, source: 'staff', note: 'Agreed by phone on 5 October' });
    expect(staff.json().actorUserId).toBeTruthy();

    expect((await post(apiKey, { purpose: 'marketing', granted: true })).statusCode).toBe(400); // an integration must say what was agreed to
    expect((await post(apiKey, { purpose: 'marketing', granted: true, text: 'Email me offers and news' })).statusCode).toBe(201);
    expect((await post(apiKey, { purpose: 'marketing', granted: false })).statusCode).toBe(201);

    const history = (await t.app.inject({ method: 'GET', url: `/v1/contacts/${ana.id}/consents`, headers: authHeaders(org.token) })).json() as Array<{ granted: boolean; source: string }>;
    expect(history.map((h) => [h.source, h.granted])).toEqual([
      ['api', false],
      ['api', true],
      ['staff', true],
    ]);
    expect((await contactRow(ana.id)).consent).toMatchObject({ marketing: { granted: false, source: 'api' } });

    // Merged into another contact: the history comes along and the latest answer stands.
    const other = await t.c.contacts.create(org.scope, { firstName: 'Ana B' });
    const merged = await t.c.contacts.mergeContacts(org.scope, { duplicateId: ana.id, primaryId: other.id });
    expect(await consentRows(other.id)).toHaveLength(3);
    expect(merged.consent).toMatchObject({ marketing: { granted: false } });
  });

  it('filters contacts by marketing consent: opted in, declined (or withdrew), never asked', async () => {
    const org = await clinic();
    const yes = await t.c.contacts.create(org.scope, { firstName: 'Yes', email: 'yes@example.com' });
    const no = await t.c.contacts.create(org.scope, { firstName: 'No', email: 'no@example.com' });
    const later = await t.c.contacts.create(org.scope, { firstName: 'Withdrew', email: 'withdrew@example.com' });
    await t.c.contacts.create(org.scope, { firstName: 'Unasked', email: 'unasked@example.com' });
    await t.c.contacts.recordConsent(org.scope, yes.id, { purpose: 'marketing', granted: true, text: 'Offers by email', source: 'api' });
    await t.c.contacts.recordConsent(org.scope, no.id, { purpose: 'marketing', granted: false, source: 'api' });
    await t.c.contacts.recordConsent(org.scope, later.id, { purpose: 'marketing', granted: true, text: 'Offers by email', source: 'api' });
    await t.c.contacts.recordConsent(org.scope, later.id, { purpose: 'marketing', granted: false, source: 'staff', note: 'Asked by phone to stop' });
    const names = async (value: string) =>
      ((await t.app.inject({ method: 'GET', url: `/v1/contacts?marketingConsent=${value}`, headers: authHeaders(org.token) })).json().items as Array<{ firstName: string }>)
        .map((c) => c.firstName)
        .sort();
    expect(await names('granted')).toEqual(['Yes']);
    expect(await names('declined')).toEqual(['No', 'Withdrew']);
    expect(await names('none')).toEqual(['Unasked']);
  });

  it('the public API records consent from a form, with its label', async () => {
    const org = await clinic();
    const key = await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: authHeaders(org.token), payload: { name: 'n8n', scopes: ['conversations:write'] } });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/channels/api/messages',
      headers: { authorization: `Bearer ${key.json().key as string}` },
      payload: { externalUserId: 'form-1', content: 'Signed up on the website', wait: false, contact: { email: 'form1@example.com', marketingConsent: { granted: true, text: 'Email me offers' } } },
    });
    await t.c.queue.drain();
    const [row] = await consentRows(res.json().contactId);
    expect(row).toMatchObject({ granted: true, text: 'Email me offers', source: 'api' });
  });

  it('sends contact.consent_updated to webhooks, with source and consent in the contact snapshot', async () => {
    const received: Array<Record<string, any>> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const org = await clinic();
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      const hook = await t.app.inject({ method: 'POST', url: '/v1/webhooks', headers: authHeaders(org.token), payload: { name: 'n8n', url, eventTypes: ['contact.consent_updated'], isActive: true } });
      expect(hook.statusCode).toBe(201);
      const contact = await t.c.contacts.create(org.scope, { firstName: 'Mo', email: 'mo@example.com' });
      await t.c.contacts.recordFirstTouch(org.scope, contact.id, { utmSource: 'google', utmCampaign: 'fall' });
      await t.app.inject({ method: 'POST', url: `/v1/contacts/${contact.id}/consents`, headers: authHeaders(org.token), payload: { purpose: 'marketing', granted: true, note: 'Signed the form at the front desk' } });
      await t.c.automation.kick();
      await t.c.queue.drain();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: 'contact.consent_updated',
        data: {
          purpose: 'marketing',
          granted: true,
          source: 'staff',
          contact: { first_touch: { utm_source: 'google', utm_campaign: 'fall' }, consent: { marketing: { granted: true, source: 'staff' } } },
        },
      });
    } finally {
      server.close();
    }
  });
});
