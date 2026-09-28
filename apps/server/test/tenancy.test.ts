import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf, schema } from '../src/db/client';
import { createOrg, createTestEnv, type TestEnv } from './helpers';

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

describe('multi-tenant isolation', () => {
  it('RLS hides other tenants even when a query forgets its org filter', async () => {
    const a = await createOrg(t.c, 'Alpha');
    const b = await createOrg(t.c, 'Beta');
    await t.c.contacts.create(a.scope, { firstName: 'Alice' });
    await t.c.contacts.create(b.scope, { firstName: 'Bob' });

    // Deliberately unscoped SQL — the kind of bug RLS exists to contain.
    const seenByA = await t.c.tenantDb.run(a.orgId, async (tx) => rowsOf<{ first_name: string }>(await tx.execute(sql`select first_name from contacts`)));
    expect(seenByA.map((r) => r.first_name)).toEqual(['Alice']);
    const botsSeenByB = await t.c.tenantDb.run(b.orgId, (tx) => tx.select().from(schema.bots));
    expect(botsSeenByB.every((bot) => bot.organizationId === b.orgId)).toBe(true);
  });

  it('RLS rejects writes into another tenant', async () => {
    const a = await createOrg(t.c, 'Gamma');
    const b = await createOrg(t.c, 'Delta');
    await expect(
      t.c.tenantDb.run(a.orgId, (tx) => tx.insert(schema.tags).values({ organizationId: b.orgId, name: 'sneaky' })),
    ).rejects.toThrow();
  });

  it('RLS covers duplicate reviews', async () => {
    const a = await createOrg(t.c, 'Iota');
    const b = await createOrg(t.c, 'Kappa');
    const owner = await t.c.contacts.create(a.scope, { email: 'owner@example.com' });
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(a.scope, { channel: 'webchat', externalId: 'visitor' });
    await t.c.contacts.captureDetails(a.scope, contactId, { email: 'owner@example.com' }, 'ai');

    const countFor = (orgId: string) =>
      t.c.tenantDb.run(orgId, async (tx) => rowsOf<{ id: string }>(await tx.execute(sql`select id from contact_merge_candidates`)).length);
    expect(await countFor(a.orgId)).toBe(1);
    expect(await countFor(b.orgId)).toBe(0);
    await expect(
      t.c.tenantDb.run(b.orgId, (tx) =>
        tx.insert(schema.contactMergeCandidates).values({ organizationId: a.orgId, contactId, existingContactId: owner.id, field: 'email', value: 'x@example.com' }),
      ),
    ).rejects.toThrow();
    await expect(t.c.contacts.listMergeCandidates(b.scope, contactId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('RLS covers consent records', async () => {
    const a = await createOrg(t.c, 'Lambda');
    const b = await createOrg(t.c, 'Mu');
    const contact = await t.c.contacts.create(a.scope, { firstName: 'Lia', email: 'lia@example.com' });
    await t.c.contacts.recordConsent(a.scope, contact.id, { purpose: 'marketing', granted: true, text: 'Email me offers', source: 'api' });

    const countFor = (orgId: string) => t.c.tenantDb.run(orgId, async (tx) => rowsOf<{ id: string }>(await tx.execute(sql`select id from contact_consents`)).length);
    expect(await countFor(a.orgId)).toBe(1);
    expect(await countFor(b.orgId)).toBe(0);
    await expect(
      t.c.tenantDb.run(b.orgId, (tx) =>
        tx.insert(schema.contactConsents).values({ organizationId: a.orgId, contactId: contact.id, purpose: 'marketing', granted: true, source: 'api' }),
      ),
    ).rejects.toThrow();
    await expect(t.c.contacts.listConsents(b.scope, contact.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('services refuse ids from another tenant', async () => {
    const a = await createOrg(t.c, 'Epsilon');
    const b = await createOrg(t.c, 'Zeta');
    const contact = await t.c.contacts.create(b.scope, { firstName: 'Zed' });
    await expect(t.c.contacts.get(a.scope, contact.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(t.c.bots.get(a.scope, b.bot.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('API: a user cannot act on an org they are not a member of', async () => {
    const a = await createOrg(t.c, 'Eta');
    const b = await createOrg(t.c, 'Theta');
    const res = await t.app.inject({ method: 'GET', url: '/v1/bots', headers: { authorization: `Bearer ${a.token}`, 'x-org-id': b.orgId } });
    expect(res.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'GET', url: '/v1/bots', headers: { authorization: `Bearer ${a.token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveLength(1);
  });
});
