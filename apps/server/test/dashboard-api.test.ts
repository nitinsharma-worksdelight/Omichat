import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/db/seed';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

describe('dashboard read endpoints (seeded demo tenant)', () => {
  it('every list/detail endpoint answers 200 with sane shapes', async () => {
    const { orgId } = await seedDemo(t.c);
    await t.c.queue.drain();
    const login = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'demo@example.com', password: 'demo-password-123' } });
    const h = authHeaders(login.json().token, orgId);
    const channel = (await t.c.channels.list({ orgId })).find((c) => c.channel === 'webchat')!;

    // One real conversation with a booking, so the lists have content.
    t.llm.setScript([
      tools({ name: 'save_contact_details', input: { name: 'Ana Silva', phone: '(416) 555-0100' } }),
      tools({ name: 'book_appointment', input: { start: '2026-09-29T10:00', customer_confirmed: true } }),
      text('Booked!'),
    ]);
    const r = await t.c.conversations.receiveInbound({ orgId, channelAccountId: channel.id, externalUserId: 'dash', content: "I'm Ana, book Tuesday 10am" });
    await t.c.queue.drain();
    await t.c.automation.dispatchPending();

    const get = async (url: string) => {
      const res = await t.app.inject({ method: 'GET', url, headers: h });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      return res.json();
    };
    const bots = await get('/v1/bots');
    expect(bots[0].config.qualification.questions).toHaveLength(3);
    const preview = await get(`/v1/bots/${bots[0].id}/preview`);
    expect(preview.system).toContain('Bright Smile Dental');
    expect(preview.tools.length).toBeGreaterThan(8);

    const inbox = await get('/v1/conversations');
    expect(inbox[0]).toMatchObject({ id: r.conversationId, contact: { name: 'Ana Silva' }, lastMessage: { content: 'Booked!' } });
    const thread = await get(`/v1/conversations/${r.conversationId}`);
    expect(thread.contact.phone).toBe('+14165550100');
    expect((await get(`/v1/conversations/${r.conversationId}/messages`)).length).toBe(2);
    const timeline = await get(`/v1/conversations/${r.conversationId}/timeline`);
    expect(timeline.tools.map((x: { toolName: string }) => x.toolName)).toEqual(['save_contact_details', 'book_appointment']);
    expect((await get(`/v1/conversations/${r.conversationId}/ai-runs`))[0].status).toBe('completed');

    const contacts = await get('/v1/contacts?leadsOnly=true');
    expect(contacts.total).toBe(1);
    await get(`/v1/contacts/${r.contactId}`);
    expect((await get(`/v1/contacts/${r.contactId}/appointments`))[0].localStart).toBe('2026-09-29T10:00');
    await get(`/v1/contacts/${r.contactId}/events`);
    expect((await get(`/v1/contacts/${r.contactId}/conversations`)).length).toBe(1);
    await get(`/v1/contacts/${r.contactId}/notes`);

    const usage = await get('/v1/usage');
    expect(usage).toMatchObject({ conversations: { total: 1 }, leads: { captured: 1 }, appointmentsBookedByAi: 1 });
    expect(usage.ai.runs).toBeGreaterThan(0);
    expect((await get('/v1/notifications')).map((n: { type: string }) => n.type)).toContain('appointment.booked');
    expect((await get('/v1/events')).length).toBeGreaterThan(3);
    await get('/v1/tasks?status=open');
    expect((await get('/v1/appointments?from=2026-09-28T00:00:00Z'))[0].contact.name).toBe('Ana Silva');
    const calendars = await get('/v1/calendars');
    expect((await get(`/v1/calendars/${calendars[0].id}/availability?from=2026-09-29&to=2026-09-29`)).slots.length).toBeGreaterThan(0);
    const kbs = await get('/v1/knowledge-bases');
    expect(kbs[0].documentCount).toBe(3);
    const docs = await get(`/v1/knowledge-bases/${kbs[0].id}/documents`);
    expect(docs.every((d: { status: string }) => d.status === 'ready')).toBe(true);
    await get(`/v1/documents/${docs[0].id}/chunks`);
    expect((await get('/v1/channels')).find((c: { channel: string }) => c.channel === 'webchat').embedSnippet).toContain('widget.js');
    expect((await get('/v1/custom-fields')).length).toBe(2);
    expect((await get('/v1/tags')).length).toBeGreaterThan(5);
    await get('/v1/webhooks');
    await get('/v1/workflows');
    await get('/v1/api-keys');
    expect((await get('/v1/members'))[0].role).toBe('owner');
    expect((await get('/v1/org')).settings.defaultCountry).toBe('CA');

    const search = await t.app.inject({
      method: 'POST',
      url: '/v1/knowledge/search',
      headers: h,
      payload: { knowledgeBaseIds: [kbs[0].id], query: 'how much does invisalign cost' },
    });
    expect(search.json().chunks[0].content).toContain('Invisalign');
  });

  it('regressions from the dashboard build', async () => {
    const org = await createOrg(t.c);
    const h = authHeaders(org.token);
    const req = async (method: 'GET' | 'PATCH' | 'POST', url: string, payload?: unknown) => {
      const res = await t.app.inject({ method, url, headers: h, payload: payload as object });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
      return res;
    };

    // PATCH keeps fields that were not sent (zod applies defaults inside .partial()).
    await req('PATCH', `/v1/calendars/${org.calendar.id}`, { bufferMinutes: 15, maxPerDay: 4 });
    const cal = (await req('PATCH', `/v1/calendars/${org.calendar.id}`, { name: 'Renamed' })).json();
    expect(cal).toMatchObject({ name: 'Renamed', bufferMinutes: 15, maxPerDay: 4 });
    await req('PATCH', `/v1/knowledge-bases/${org.kb.id}`, { description: 'Kept' });
    expect((await req('PATCH', `/v1/knowledge-bases/${org.kb.id}`, { name: 'KB' })).json().description).toBe('Kept');
    const hook = (await req('POST', '/v1/webhooks', { name: 'n8n', url: 'https://example.com/hook', eventTypes: ['lead.qualified'], isActive: false })).json();
    expect((await req('PATCH', `/v1/webhooks/${hook.id}`, { name: 'n8n 2' })).json()).toMatchObject({ eventTypes: ['lead.qualified'], isActive: false });
    const field = (await req('POST', '/v1/custom-fields', { key: 'plan', label: 'Plan', type: 'select', options: ['A', 'B'], aiWritable: false })).json();
    expect((await req('PATCH', `/v1/custom-fields/${field.id}`, { label: 'Plan tier' })).json()).toMatchObject({ type: 'select', options: ['A', 'B'], aiWritable: false });

    // Query booleans: "false" means false.
    await t.c.automation.notifyTeam(org.scope, { subject: 'Hello', message: 'x', urgency: 'normal' });
    await t.c.automation.dispatchPending();
    const [n] = (await req('GET', '/v1/notifications')).json();
    await req('POST', '/v1/notifications/read', { ids: [n.id] });
    expect((await req('GET', '/v1/notifications?unreadOnly=false')).json()).toHaveLength(1);
    expect((await req('GET', '/v1/notifications?unreadOnly=true')).json()).toHaveLength(0);

    // from=now is accepted.
    await req('GET', '/v1/appointments?from=now');

    // Theme fields can be cleared.
    await req('PATCH', `/v1/channels/${org.webchat.id}`, { config: { theme: { avatarUrl: 'https://example.com/a.png', subtitle: 'Hi' } } });
    const cleared = (await req('PATCH', `/v1/channels/${org.webchat.id}`, { config: { theme: { avatarUrl: '', subtitle: null } } })).json();
    expect(cleared.config.theme.avatarUrl).toBeUndefined();
    expect(cleared.config.theme.subtitle).toBeUndefined();
    expect(cleared.config.theme.primaryColor).toBe('#4f46e5');

    // Member roles can change; the owner's cannot.
    const member = (await req('POST', '/v1/members', { email: `m-${Date.now()}@example.com`, role: 'viewer', password: 'password-123' })).json();
    expect((await req('PATCH', `/v1/members/${member.userId}`, { role: 'agent' })).json().role).toBe('agent');
    const me = (await req('GET', '/v1/me')).json();
    const denied = await t.app.inject({ method: 'PATCH', url: `/v1/members/${me.user.id}`, headers: h, payload: { role: 'viewer' } });
    expect(denied.statusCode).toBe(400);

    // Inbox search + total; events carry contact names; manual workflow tests are attributed to the user.
    t.llm.setScript([text('hi')]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'srch', content: 'hello' });
    await t.c.contacts.captureDetails(org.scope, r.contactId, { name: 'Zoe Quartz' }, 'ai');
    await t.c.queue.drain();
    const found = await req('GET', '/v1/conversations?search=quartz');
    expect(found.json()).toHaveLength(1);
    expect(found.headers['x-total-count']).toBe('1');
    expect((await req('GET', '/v1/conversations?search=nobody')).json()).toHaveLength(0);
    const events = (await req('GET', '/v1/events')).json();
    expect(events.find((e: { contactId: string | null }) => e.contactId === r.contactId).contactName).toBe('Zoe Quartz');
  });
});
