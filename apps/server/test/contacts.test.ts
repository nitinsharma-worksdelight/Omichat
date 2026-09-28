import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

describe('lead capture', () => {
  it('validates, normalizes and reports per-field errors', async () => {
    const org = await createOrg(t.c);
    await t.c.tenancy.updateOrganization(org.orgId, { settings: { defaultCountry: 'CA' } });
    await t.c.contacts.createFieldDef(org.scope, { key: 'budget', label: 'Budget', type: 'number', options: [], description: '', aiWritable: true });
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'visitor-1' });
    const result = await t.c.contacts.captureDetails(
      org.scope,
      contactId,
      { name: 'Jane Q Doe', email: 'not-an-email', phone: '416 555 0123', customFields: { budget: '5,000', unknown_field: 'x' } },
      'ai',
    );
    expect(result.errors).toHaveLength(2);
    expect(result.leadCaptured).toBe(true);
    const contact = await t.c.contacts.get(org.scope, contactId);
    expect(contact).toMatchObject({ firstName: 'Jane', lastName: 'Q Doe', phone: '+14165550123', email: null, lifecycleStage: 'engaged' });
    expect(contact.customFields).toEqual({ budget: 5000 });
  });

  it('placeholders such as "unknown" are never saved as details', async () => {
    const org = await createOrg(t.c);
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'placeholder' });
    const result = await t.c.contacts.captureDetails(org.scope, contactId, { name: 'Unknown', email: 'unknown', phone: 'N/A', company: '(not given yet)' }, 'ai');
    expect(result.changed).toEqual([]);
    expect(result.errors).toHaveLength(4);
    expect(result.errors.every((e) => e.includes('placeholder'))).toBe(true);
    expect(await t.c.contacts.get(org.scope, contactId)).toMatchObject({ firstName: null, lastName: null, email: null, phone: null, company: null });

    // Real details still save, including ones that merely contain such a word.
    await t.c.contacts.captureDetails(org.scope, contactId, { name: 'Nonie Guest', company: 'Unknown Mortals Ltd' }, 'ai');
    expect(await t.c.contacts.get(org.scope, contactId)).toMatchObject({ firstName: 'Nonie', lastName: 'Guest', company: 'Unknown Mortals Ltd' });
  });

  it('the assistant copying "unknown" from its context saves nothing and is told why', async () => {
    const org = await createOrg(t.c);
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'unknown', email: 'unknown' } }), text('ok')]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'copier', content: 'I want Invisalign' });
    await t.c.queue.drain();
    const context = JSON.stringify(t.llm.requests[0]!.messages);
    expect(context).toContain('name: (not given yet)');
    expect(context).not.toContain('name: unknown');
    expect(lastToolResults(t.llm)[0]!.isError).toBe(true);
    expect((await t.c.contacts.get(org.scope, r.contactId)).firstName).toBeNull();
  });

  it('verified details (an integration) merge a returning visitor into the existing contact', async () => {
    const org = await createOrg(t.c);
    const first = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'laptop' });
    await t.c.contacts.captureDetails(org.scope, first.contactId, { name: 'Sam Lee', email: 'sam@example.com' }, 'ai');
    await t.c.contacts.addNote(org.scope, first.contactId, 'Prefers mornings', 'ai');

    const second = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'phone' });
    expect(second.contactId).not.toBe(first.contactId);
    await t.c.contacts.addTags(org.scope, second.contactId, ['vip'], { addedBy: 'user', allowCreate: true });
    const result = await t.c.contacts.captureDetails(org.scope, second.contactId, { email: 'SAM@example.com', company: 'Lee Inc' }, 'contact', {
      trust: 'verified',
    });

    expect(result.mergedIntoId).toBe(first.contactId);
    const merged = await t.c.contacts.get(org.scope, first.contactId);
    expect(merged).toMatchObject({ company: 'Lee Inc', email: 'sam@example.com' });
    expect(merged.tags.map((tg) => tg.name)).toEqual(['vip']);
    expect(merged.memory.map((m) => m.text)).toContain('Prefers mornings');
    // The second device's identity now resolves to the surviving contact.
    const again = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'phone' });
    expect(again.contactId).toBe(first.contactId);
    const list = await t.c.contacts.list(org.scope, { leadsOnly: true, limit: 50, offset: 0 });
    expect(list.total).toBe(1);
  });

  it('an email or phone typed in a chat that belongs to someone else becomes a review, never a merge', async () => {
    const org = await createOrg(t.c);
    const owner = await t.c.contacts.create(org.scope, { firstName: 'Sam', email: 'sam@example.com', phone: '+14165550123', company: 'Lee Inc' });
    const visitor = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'stranger' });
    const result = await t.c.contacts.captureDetails(org.scope, visitor.contactId, { name: 'Pat', email: 'SAM@example.com', phone: '+1 416 555 0123' }, 'ai');

    expect(result).toMatchObject({ contactId: visitor.contactId, changed: ['firstName'], leadCaptured: false });
    expect(result.claimed.sort()).toEqual(['email', 'phone']);
    expect(result.mergedIntoId).toBeUndefined();
    // Neither record changed hands.
    expect(await t.c.contacts.get(org.scope, owner.id)).toMatchObject({ firstName: 'Sam', email: 'sam@example.com', company: 'Lee Inc' });
    expect(await t.c.contacts.get(org.scope, visitor.contactId)).toMatchObject({ firstName: 'Pat', email: null, phone: null });
    expect((await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'stranger' })).contactId).toBe(visitor.contactId);
    // In their own conversation the visitor's own words count — and nothing of the owner's.
    expect(await t.c.contacts.getForConversation(org.scope, visitor.contactId)).toMatchObject({
      name: 'Pat',
      email: 'sam@example.com',
      phone: '+14165550123',
      company: null,
    });

    // One review per field, visible from both sides; saying it again doesn't add another.
    await t.c.contacts.captureDetails(org.scope, visitor.contactId, { email: 'sam@example.com' }, 'ai');
    const reviews = await t.c.contacts.listMergeCandidates(org.scope, owner.id);
    expect(reviews.map((r) => r.field).sort()).toEqual(['email', 'phone']);
    expect(reviews[0]).toMatchObject({ status: 'pending', claimant: { id: visitor.contactId }, existing: { id: owner.id } });
    expect(await t.c.contacts.listMergeCandidates(org.scope, visitor.contactId)).toHaveLength(2);
    const events = await t.c.automation.listEvents(org.scope, { contactId: visitor.contactId });
    expect(events.filter((e) => e.type === 'contact.duplicate_detected')).toHaveLength(2);
    // Visitors with a pending review show up as leads.
    const leads = await t.c.contacts.list(org.scope, { leadsOnly: true, limit: 50, offset: 0 });
    expect(leads.items.find((c) => c.id === visitor.contactId)).toMatchObject({ hasPendingMerge: true });
  });

  it('a capture that loses a race for the same email becomes a review instead of a crash', async () => {
    const org = await createOrg(t.c);
    const owner = await t.c.contacts.create(org.scope, { firstName: 'Ann', email: 'ann@example.com' });
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'racer' });
    // The duplicate check sees the email as free, but another contact holds it by the time of the write.
    const spy = vi
      .spyOn(t.c.contacts as unknown as { findByField: (...args: unknown[]) => Promise<unknown> }, 'findByField')
      .mockResolvedValueOnce(null);
    try {
      const result = await t.c.contacts.captureDetails(org.scope, contactId, { name: 'Ann', email: 'ann@example.com' }, 'ai');
      expect(result).toMatchObject({ claimed: ['email'], changed: ['firstName'] });
    } finally {
      spy.mockRestore();
    }
    expect(await t.c.contacts.get(org.scope, contactId)).toMatchObject({ firstName: 'Ann', email: null });
    expect(await t.c.contacts.listMergeCandidates(org.scope, contactId)).toMatchObject([{ field: 'email', existing: { id: owner.id } }]);
  });

  it('dashboard edits refuse to steal another contact\'s email', async () => {
    const org = await createOrg(t.c);
    await t.c.contacts.create(org.scope, { email: 'taken@example.com' });
    const other = await t.c.contacts.create(org.scope, { firstName: 'Other' });
    await expect(t.c.contacts.update(org.scope, other.id, { email: 'Taken@example.com' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('tag policies: allowed list and creation', async () => {
    const org = await createOrg(t.c);
    await t.c.contacts.createTag(org.scope, { name: 'hot-lead' });
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'v' });
    const r = await t.c.contacts.addTags(org.scope, contactId, ['hot-lead', 'brand-new', 'other'], { addedBy: 'ai', allowCreate: false, allowed: ['hot-lead', 'brand-new'] });
    expect(r.added).toEqual(['hot-lead']);
    expect(r.skipped).toEqual(['brand-new (tag does not exist)', 'other (not an allowed tag)']);
  });
});
