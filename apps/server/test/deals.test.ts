import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf, schema } from '../src/db/client';
import { verifyWebhookSignature } from '../src/lib/crypto';
import { authHeaders, createOrg, createTestEnv, type TestEnv } from './helpers';

/**
 * F4b — Deals and pipelines. Every organization has a pipeline; deals move through its stages and are won or lost;
 * each change is one event; contacts, roles, API-key scopes and tenants are respected.
 */

let t: TestEnv;
let receiver: Server;
let receiverUrl: string;
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

beforeAll(async () => {
  t = await createTestEnv();
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()));
  await t.close();
});

type Org = Awaited<ReturnType<typeof createOrg>>;
type Pipeline = { id: string; name: string; stages: Array<{ id: string; name: string }> };
type Deal = {
  id: string;
  title: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  value: number | null;
  currency: string;
  status: 'open' | 'won' | 'lost';
  lostReason: string | null;
  ownerUserId: string | null;
  expectedCloseOn: string | null;
  createdBy: string;
  closedAt: string | null;
};

const as = (token: string) => ({ headers: authHeaders(token) });
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, auth: { headers: Record<string, string> }, payload?: unknown) =>
  t.app.inject({ method, url, ...auth, ...(payload === undefined ? {} : { payload: payload as object }) });

async function pipelinesOf(org: Org): Promise<Pipeline[]> {
  const res = await call('GET', '/v1/pipelines', as(org.token));
  expect(res.statusCode).toBe(200);
  return res.json() as Pipeline[];
}
const stage = (p: Pipeline, name: string) => p.stages.find((s) => s.name === name)!.id;

async function newContact(org: Org, name: string) {
  return (await t.c.contacts.create(org.scope, { firstName: name, email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@example.com` })).id;
}

async function newDeal(org: Org, body: Record<string, unknown>): Promise<Deal> {
  const res = await call('POST', '/v1/deals', as(org.token), body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Deal;
}

async function eventsOf(orgId: string, dealEventsFor?: string) {
  const rows = await t.c.tenantDb.run(orgId, (tx) => tx.select().from(schema.events).where(eq(schema.events.organizationId, orgId)));
  return rows
    .filter((e) => e.type.startsWith('deal.'))
    .filter((e) => !dealEventsFor || JSON.stringify(e.payload).includes(dealEventsFor))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function member(org: Org, role: 'viewer' | 'agent' | 'admin') {
  const email = `${role}-${Math.random().toString(36).slice(2)}@example.com`;
  await call('POST', '/v1/members', as(org.token), { email, role, password: 'member-password-1' });
  return (await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'member-password-1' } })).json().token as string;
}

describe('pipelines', () => {
  it('every organization has a "Sales" pipeline: new ones from sign-up, older ones on first use, once', async () => {
    const org = await createOrg(t.c, 'Pipeline Clinic');
    const stored = await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.pipelines));
    expect(stored).toHaveLength(1);
    const [sales] = await pipelinesOf(org);
    expect(sales).toMatchObject({ name: 'Sales' });
    expect(sales!.stages.map((s) => s.name)).toEqual(['New', 'Qualified', 'Proposal', 'Negotiation']);

    // An organization from before deals existed has none until it opens them; two first uses make one.
    const older = await createOrg(t.c, 'Older Clinic');
    await t.c.tenantDb.run(older.orgId, (tx) => tx.delete(schema.pipelines).where(eq(schema.pipelines.organizationId, older.orgId)));
    const [a, b] = await Promise.all([pipelinesOf(older), pipelinesOf(older)]);
    expect(a!.map((p) => p.id)).toEqual(b!.map((p) => p.id));
    expect(await t.c.tenantDb.run(older.orgId, (tx) => tx.select().from(schema.pipelines))).toHaveLength(1);
  });

  it('stages with deals move before they go; the last pipeline and pipelines with deals stay', async () => {
    const org = await createOrg(t.c, 'Stages Clinic');
    const [sales] = await pipelinesOf(org);
    const deal = await newDeal(org, { title: 'Implants', contactId: await newContact(org, 'Iris'), stageId: stage(sales!, 'Proposal') });
    const kept = sales!.stages.filter((s) => s.name !== 'Proposal').map((s) => ({ id: s.id, name: s.name === 'New' ? 'Enquiry' : s.name }));
    const url = `/v1/pipelines/${sales!.id}`;

    const refused = await call('PATCH', url, as(org.token), { stages: [...kept, { name: 'Contract' }] });
    expect(refused.statusCode).toBe(409);
    expect((await call('GET', `/v1/deals/${deal.id}`, as(org.token))).json()).toMatchObject({ stageId: stage(sales!, 'Proposal') });

    const saved = await call('PATCH', url, as(org.token), { stages: [...kept, { name: 'Contract' }], moveDealsTo: { [stage(sales!, 'Proposal')]: stage(sales!, 'Negotiation') } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((saved.json() as Pipeline).stages.map((s) => s.name)).toEqual(['Enquiry', 'Qualified', 'Negotiation', 'Contract']);
    expect((await call('GET', `/v1/deals/${deal.id}`, as(org.token))).json()).toMatchObject({ stageId: stage(sales!, 'Negotiation') });

    const extra = await call('POST', '/v1/pipelines', as(org.token), { name: 'Partnerships', stages: [{ name: 'Intro' }, { name: 'Pilot' }] });
    expect(extra.statusCode).toBe(201);
    expect((await call('DELETE', `/v1/pipelines/${sales!.id}`, as(org.token))).statusCode).toBe(409); // it has a deal
    expect((await call('DELETE', `/v1/pipelines/${extra.json().id}`, as(org.token))).statusCode).toBe(204);

    const lone = await createOrg(t.c, 'Lone Clinic');
    const [only] = await pipelinesOf(lone);
    expect((await call('DELETE', `/v1/pipelines/${only!.id}`, as(lone.token))).statusCode).toBe(409); // the last one
  });
});

describe('deals', () => {
  it("start in the first stage in the organization's currency, and follow the pipeline and owner rules", async () => {
    const org = await createOrg(t.c, 'Deal Clinic');
    const [sales] = await pipelinesOf(org);
    const contactId = await newContact(org, 'Ana');
    const deal = await newDeal(org, { title: 'Invisalign', contactId, value: 4500, expectedCloseOn: '2026-10-15' });
    expect(deal).toMatchObject({
      title: 'Invisalign',
      contactId,
      pipelineId: sales!.id,
      stageId: stage(sales!, 'New'),
      value: 4500,
      currency: 'USD',
      status: 'open',
      expectedCloseOn: '2026-10-15',
      createdBy: 'user',
      closedAt: null,
    });

    expect((await call('PATCH', '/v1/org', as(org.token), { settings: { currency: 'eur' } })).statusCode).toBe(200);
    expect((await newDeal(org, { title: 'Whitening', contactId, value: 450 })).currency).toBe('EUR');
    expect((await call('PATCH', '/v1/org', as(org.token), { settings: { currency: 'XYZ' } })).statusCode).toBe(400);
    expect((await newDeal(org, { title: 'Big', contactId, value: 999_999_999_999.99 })).value).toBe(999_999_999_999.99);
    expect((await call('POST', '/v1/deals', as(org.token), { title: 'Too big', contactId, value: 1_000_000_000_000 })).statusCode).toBe(400);

    const other = (await call('POST', '/v1/pipelines', as(org.token), { name: 'Partnerships', stages: [{ name: 'Intro' }] })).json() as Pipeline;
    expect((await call('POST', '/v1/deals', as(org.token), { title: 'Mixed', contactId, pipelineId: sales!.id, stageId: other.stages[0]!.id })).statusCode).toBe(400);
    const url = `/v1/deals/${deal.id}`;
    expect((await call('PATCH', url, as(org.token), { pipelineId: other.id })).statusCode).toBe(400);
    expect((await call('PATCH', url, as(org.token), { pipelineId: other.id, stageId: other.stages[0]!.id })).json()).toMatchObject({ pipelineId: other.id, stageId: other.stages[0]!.id });

    expect((await call('PATCH', url, as(org.token), { ownerUserId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
    const me = (await call('GET', '/v1/me', as(org.token))).json().user.id as string;
    expect((await call('PATCH', url, as(org.token), { ownerUserId: me })).json()).toMatchObject({ ownerUserId: me });

    const elsewhere = await createOrg(t.c, 'Elsewhere Clinic');
    const theirs = await newContact(elsewhere, 'Zed');
    expect((await call('POST', '/v1/deals', as(org.token), { title: 'Theirs', contactId: theirs })).statusCode).toBe(404);
  });

  it('won and lost record when, reopening clears it, and each change is one event (signed to webhooks)', async () => {
    const org = await createOrg(t.c, 'Events Clinic');
    const ep = await call('POST', '/v1/webhooks', as(org.token), { name: 'crm', url: `${receiverUrl}/deals`, eventTypes: ['deal.won'] });
    expect(ep.statusCode).toBe(201);
    const [sales] = await pipelinesOf(org);
    const contactId = await newContact(org, 'Eve');
    const deal = await newDeal(org, { title: 'Braces', contactId, value: 3000 });
    const url = `/v1/deals/${deal.id}`;

    await call('PATCH', url, as(org.token), { title: 'Braces (adult)', value: 3200 });
    await call('PATCH', url, as(org.token), { stageId: stage(sales!, 'Qualified') });
    const won = (await call('PATCH', url, as(org.token), { status: 'won' })).json() as Deal;
    expect(won).toMatchObject({ status: 'won', lostReason: null });
    expect(won.closedAt).toEqual(expect.any(String));
    const reopened = (await call('PATCH', url, as(org.token), { status: 'open' })).json() as Deal;
    expect(reopened).toMatchObject({ status: 'open', closedAt: null });
    const lost = (await call('PATCH', url, as(org.token), { status: 'lost', lostReason: 'Went with another clinic' })).json() as Deal;
    expect(lost).toMatchObject({ status: 'lost', lostReason: 'Went with another clinic' });
    expect(lost.closedAt).toEqual(expect.any(String));
    expect((await call('DELETE', url, as(org.token))).statusCode).toBe(204);
    expect((await call('GET', url, as(org.token))).statusCode).toBe(404);

    const events = await eventsOf(org.orgId, deal.id);
    expect(events.map((e) => e.type)).toEqual(['deal.created', 'deal.updated', 'deal.stage_changed', 'deal.won', 'deal.updated', 'deal.lost', 'deal.deleted']);
    expect(events[1]!.payload).toMatchObject({ changed: ['title', 'value'] });
    expect(events[2]!.payload).toMatchObject({ from: { stage: 'New' }, to: { stage: 'Qualified' } });
    expect(events[4]!.payload).toMatchObject({ changed: ['status'] });
    expect(events[5]!.payload).toMatchObject({ reason: 'Went with another clinic' });
    expect(events.every((e) => e.contactId === contactId)).toBe(true);

    await t.c.automation.dispatchPending();
    await t.c.queue.drain();
    const delivered = received.filter((r) => r.headers['x-omni-event'] === 'deal.won');
    expect(delivered).toHaveLength(1);
    expect(verifyWebhookSignature(ep.json().secret, delivered[0]!.body, String(delivered[0]!.headers['x-omni-signature']))).toBe(true);
    expect(JSON.parse(delivered[0]!.body)).toMatchObject({ type: 'deal.won', data: { deal: { id: deal.id, title: 'Braces (adult)', value: 3200, stage: 'Qualified' }, contact: { id: contactId } } });
  });

  it('the board summary counts deals and totals their values per stage', async () => {
    const org = await createOrg(t.c, 'Board Clinic');
    const [sales] = await pipelinesOf(org);
    const contactId = await newContact(org, 'Bo');
    await newDeal(org, { title: 'A', contactId, value: 1000 });
    await newDeal(org, { title: 'B', contactId, value: 2500 });
    await newDeal(org, { title: 'C', contactId, stageId: stage(sales!, 'Qualified') });
    const done = await newDeal(org, { title: 'D', contactId, value: 9999 });
    await call('PATCH', `/v1/deals/${done.id}`, as(org.token), { status: 'won' });

    const summary = (await call('GET', `/v1/deals/summary?pipelineId=${sales!.id}&status=open`, as(org.token))).json() as Array<{ stageId: string; count: number; totals: Array<{ currency: string; value: number }> }>;
    expect(summary.find((s) => s.stageId === stage(sales!, 'New'))).toMatchObject({ count: 2, totals: [{ currency: 'USD', value: 3500 }] });
    expect(summary.find((s) => s.stageId === stage(sales!, 'Qualified'))).toMatchObject({ count: 1, totals: [] });

    const page = await call('GET', `/v1/deals?pipelineId=${sales!.id}&stageId=${stage(sales!, 'New')}&status=open&limit=1`, as(org.token));
    expect(page.json()).toHaveLength(1);
    expect(page.headers['x-total-count']).toBe('2');
    const mine = (await call('GET', `/v1/contacts/${contactId}/deals`, as(org.token))).json() as Deal[];
    expect(mine.map((d) => d.title).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('merging contacts moves their deals; deleting a contact deletes them', async () => {
    const org = await createOrg(t.c, 'Merge Deals Clinic');
    const duplicate = await newContact(org, 'Dup');
    const primary = await newContact(org, 'Prime');
    const deal = await newDeal(org, { title: 'Crown', contactId: duplicate });
    expect((await call('POST', `/v1/contacts/${duplicate}/merge`, as(org.token), { intoContactId: primary })).statusCode).toBe(200);
    expect((await call('GET', `/v1/deals/${deal.id}`, as(org.token))).json()).toMatchObject({ contactId: primary });
    expect((await call('DELETE', `/v1/contacts/${primary}`, as(org.token))).statusCode).toBe(204);
    expect((await call('GET', `/v1/deals/${deal.id}`, as(org.token))).statusCode).toBe(404);
  });
});

describe('access', () => {
  it('viewers read, agents write, admins shape pipelines; keys need the deal scopes', async () => {
    const org = await createOrg(t.c, 'Roles Clinic');
    const [sales] = await pipelinesOf(org);
    const contactId = await newContact(org, 'Rae');
    const body = { title: 'Veneers', contactId };
    const viewer = await member(org, 'viewer');
    const agent = await member(org, 'agent');
    expect((await call('GET', '/v1/deals', as(viewer))).statusCode).toBe(200);
    expect((await call('POST', '/v1/deals', as(viewer), body)).statusCode).toBe(403);
    expect((await call('POST', '/v1/deals', as(agent), body)).statusCode).toBe(201);
    expect((await call('PATCH', `/v1/pipelines/${sales!.id}`, as(agent), { name: 'Pipeline' })).statusCode).toBe(403);
    expect((await call('PATCH', `/v1/pipelines/${sales!.id}`, as(org.token), { name: 'Clinic sales' })).json()).toMatchObject({ name: 'Clinic sales' });

    const keyFor = async (scopes: string[]) => ({ headers: { authorization: `Bearer ${(await call('POST', '/v1/api-keys', as(org.token), { name: 'crm', scopes })).json().key}` } });
    const reader = await keyFor(['deals:read']);
    const writer = await keyFor(['deals:read', 'deals:write']);
    expect((await call('GET', '/v1/deals', reader)).statusCode).toBe(200);
    expect((await call('GET', '/v1/pipelines', reader)).statusCode).toBe(200);
    expect((await call('POST', '/v1/deals', reader, body)).statusCode).toBe(403);
    const viaKey = await call('POST', '/v1/deals', writer, body);
    expect(viaKey.statusCode).toBe(201);
    expect(viaKey.json()).toMatchObject({ createdBy: 'api' });
    expect((await call('PATCH', `/v1/pipelines/${sales!.id}`, writer, { name: 'X' })).statusCode).toBe(401);
    expect((await call('GET', '/v1/deals', await keyFor(['contacts:read']))).statusCode).toBe(403);

    // A contact's owner, like a deal's, must be on the team.
    const me = (await call('GET', '/v1/me', as(org.token))).json().user.id as string;
    expect((await call('PATCH', `/v1/contacts/${contactId}`, as(org.token), { ownerUserId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
    expect((await call('PATCH', `/v1/contacts/${contactId}`, as(org.token), { ownerUserId: me })).json()).toMatchObject({ ownerUserId: me });
  });

  it("another organization's deals and pipelines stay out of reach (RLS)", async () => {
    const a = await createOrg(t.c, 'Tenant A Clinic');
    const b = await createOrg(t.c, 'Tenant B Clinic');
    const deal = await newDeal(a, { title: 'Secret', contactId: await newContact(a, 'Sid') });
    const [aPipeline] = await pipelinesOf(a);
    expect((await call('GET', `/v1/deals/${deal.id}`, as(b.token))).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/deals/${deal.id}`, as(b.token), { title: 'Mine now' })).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/pipelines/${aPipeline!.id}`, as(b.token), { name: 'Mine' })).statusCode).toBe(404);
    expect(((await call('GET', '/v1/deals', as(b.token))).json() as Deal[]).map((d) => d.id)).not.toContain(deal.id);

    const seen = (orgId: string) => t.c.tenantDb.run(orgId, async (tx) => rowsOf<{ id: string }>(await tx.execute(sql`select id from deals`)).length);
    expect(await seen(a.orgId)).toBe(1);
    expect(await seen(b.orgId)).toBe(0);
    await expect(
      t.c.tenantDb.run(b.orgId, (tx) =>
        tx.insert(schema.deals).values({ organizationId: a.orgId, pipelineId: aPipeline!.id, stageId: aPipeline!.stages[0]!.id, contactId: deal.contactId, title: 'sneaky' }),
      ),
    ).rejects.toThrow();
    expect(await t.c.tenantDb.run(b.orgId, (tx) => tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.pipelineId, aPipeline!.id))))).toHaveLength(0);
  });
});
