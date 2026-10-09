import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogEmailSender } from '../src/infra/email';
import { orgChannel } from '../src/modules/conversations/service';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/**
 * Approvals are live: the moment the assistant asks, or a teammate answers, open dashboards are told (the sidebar badge,
 * the Approvals page and a conversation's cards refresh), and the others on the team hear what was decided.
 */

let t: TestEnv;
let baseUrl: string;
beforeAll(async () => {
  t = await createTestEnv();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
type Change = { type: string; approvalId: string; conversationId: string; status: string };

/** An organization whose bot asks the team before booking, and a way to have a visitor ask for one. */
async function setup(name: string) {
  const org = await createOrg(t.c, name);
  await t.c.bots.update(org.scope, org.bot.id, {
    config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] }, actions: { ...org.bot.config.actions, askFirst: ['book_appointment'] } },
  });
  const changes: Change[] = [];
  const stop = t.c.pubsub.subscribe(orgChannel(org.orgId), (m) => {
    if ((m as { type: string }).type === 'approval.changed') changes.push(m as Change);
  });
  const ask = async (visitor: string, start: string, opts: { isTest?: boolean } = {}) => {
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Quinn' } }, { name: 'book_appointment', input: { start, customer_confirmed: true } }), text('I asked the team.')]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content: 'Please book me', ...opts });
    await t.c.queue.drain();
    return r;
  };
  const pending = async () =>
    (await t.app.inject({ method: 'GET', url: '/v1/approvals?status=pending', headers: authHeaders(org.token, org.orgId) })).json() as Array<{ id: string; conversationId: string }>;
  return { org, changes, stop, ask, pending };
}
const decide = (org: Org, id: string, action: 'approve' | 'reject', payload: object = {}) =>
  t.app.inject({ method: 'POST', url: `/v1/approvals/${id}/${action}`, headers: authHeaders(org.token, org.orgId), payload });

async function teammate(org: Org, name: string) {
  const email = `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@example.com`;
  return { ...(await t.c.tenancy.addMember(org.orgId, { email, role: 'agent', name, password: 'password-123' })), email };
}

describe('the team is told at once', () => {
  it('when the assistant asks, with nothing but the request itself needed', async () => {
    const { org, changes, stop, ask, pending } = await setup('Live Request Co');
    const r = await ask('v1', '2026-09-29T09:30');
    const [request] = await pending();
    expect(changes).toEqual([{ type: 'approval.changed', approvalId: request!.id, conversationId: r.conversationId, status: 'pending' }]);
    stop();
  });

  it('when a teammate approves or declines, so the others\' badges and lists change', async () => {
    const { org, changes, stop, ask, pending } = await setup('Live Decision Co');
    await ask('a', '2026-09-29T09:30');
    await ask('b', '2026-09-29T10:30');
    const [first, second] = await pending();
    changes.length = 0;

    expect((await decide(org, first!.id, 'approve')).statusCode).toBe(200);
    expect((await decide(org, second!.id, 'reject', { reason: 'Fully booked that day' })).statusCode).toBe(200);
    await t.c.queue.drain();
    expect(changes.map((c) => [c.approvalId, c.status])).toEqual([
      [first!.id, 'approved'],
      [second!.id, 'rejected'],
    ]);
    stop();
  });

  it("for a Test chat too (its requests show on the Approvals page), but without bothering the team's inbox", async () => {
    const { org, changes, stop, ask } = await setup('Live Test Chat Co');
    await ask('tester', '2026-09-29T09:30', { isTest: true });
    expect(changes).toHaveLength(1);
    const owner = (await t.c.tenancy.listMembers(org.orgId))[0]!;
    expect(await t.c.automation.listNotifications(org.scope, owner.userId)).toHaveLength(0);
    stop();
  });

  it('reaches a dashboard over the real stream, with the notification beside it', async () => {
    const { org, stop, ask, pending } = await setup('Live Stream Co');
    const res = await fetch(`${baseUrl}/v1/stream`, { headers: authHeaders(org.token, org.orgId) });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    const reading = (async () => {
      let buf = '';
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (const m of buf.matchAll(/^event: (.+)$/gm)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
        if (seen.includes('approval.changed') && seen.includes('notification')) break;
      }
      await reader.cancel();
    })();
    await ask('streamer', '2026-09-29T09:30');
    await reading;
    expect(await pending()).toHaveLength(1);
    expect(seen).toContain('approval.changed');
    expect(seen).toContain('notification');
    stop();
  });
});

describe('the alert does not wait for the turn to finish', () => {
  it('is nudged as soon as the request is saved, before the assistant has written its reply', async () => {
    const { org, stop } = await setup('Early Alert Co');
    let kicks = 0;
    const original = t.c.automation.kick.bind(t.c.automation);
    t.c.automation.kick = (async () => {
      kicks++;
      return original();
    }) as typeof t.c.automation.kick;
    let kicksWhenReplyWritten = -1;
    let kicksWhenAsked = -1;
    t.llm.setScript([
      (req, call) => {
        kicksWhenAsked = kicks;
        return tools({ name: 'save_contact_details', input: { name: 'Quinn' } }, { name: 'book_appointment', input: { start: '2026-09-29T09:30', customer_confirmed: true } })(req, call);
      },
      // The model's second call is the one that writes the reply: the request was saved before it.
      () => {
        kicksWhenReplyWritten = kicks;
        return text('I asked the team.')();
      },
    ]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'early', content: 'Please book me' });
    await t.c.queue.drain();
    t.c.automation.kick = original as typeof t.c.automation.kick;
    expect(kicksWhenReplyWritten).toBeGreaterThan(kicksWhenAsked);
    stop();
  });
});

describe('what the team decided is shown to the others', () => {
  it("is a notification for everyone but the one who decided, and it is not emailed", async () => {
    const { org, stop, ask, pending } = await setup('Decision Note Co');
    await t.c.tenancy.updateOrganization(org.orgId, { settings: { notificationEmails: ['team@example.com'] } });
    const owner = (await t.c.tenancy.listMembers(org.orgId)).find((m) => m.role === 'owner')!;
    const sam = await teammate(org, 'Sam');
    await ask('n1', '2026-09-29T09:30');
    await ask('n2', '2026-09-29T10:30');
    const [one, two] = await pending();

    // The requests themselves were emailed (so the "not emailed" check below can fail).
    expect((t.c.email as LogEmailSender).sent.some((m) => /Approval needed/.test(m.subject))).toBe(true);
    const emailsBefore = (t.c.email as LogEmailSender).sent.length;
    await decide(org, one!.id, 'approve');
    await decide(org, two!.id, 'reject', { reason: 'Fully booked that day' });
    await t.c.queue.drain();

    const types = async (userId: string, unreadOnly = false) => (await t.c.automation.listNotifications(org.scope, userId, { unreadOnly })).map((n) => n.type).sort();
    // The owner (who decided) has them listed but read; Sam sees both as unread.
    expect(await types(sam.userId, true)).toEqual(expect.arrayContaining(['action.approved', 'action.rejected']));
    expect(await types(owner.userId, true)).not.toContain('action.approved');
    expect(await types(owner.userId, true)).not.toContain('action.rejected');
    expect(await types(owner.userId)).toEqual(expect.arrayContaining(['action.approved', 'action.rejected']));

    const declined = (await t.c.automation.listNotifications(org.scope, sam.userId)).find((n) => n.type === 'action.rejected')!;
    expect(declined.title).toMatch(/^Declined: /);
    expect(declined.body).toContain('Fully booked that day');
    expect(declined.data).toMatchObject({ byUserId: owner.userId });
    // Only the original "Approval needed" alerts were emailed; the decisions were not.
    const sent = (t.c.email as LogEmailSender).sent.slice(emailsBefore);
    expect(sent.some((m) => /Approved:|Declined:/.test(m.subject))).toBe(false);
    stop();
  });
});
