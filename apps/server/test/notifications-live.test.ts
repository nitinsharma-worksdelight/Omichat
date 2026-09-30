import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgChannel, userChannel } from '../src/modules/conversations/service';
import { createOrg, createTestEnv, type TestEnv } from './helpers';

/** Open dashboards hear about new notifications at once: org-wide ones on the org stream, personal ones only on their owner's. */

type Org = Awaited<ReturnType<typeof createOrg>>;

async function send(env: TestEnv, org: Org, content: string, visitor = 'visitor') {
  const r = await env.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await env.c.queue.drain();
  return r;
}

function listen(t: TestEnv, channel: string) {
  const got: Array<{ type: string; id?: string }> = [];
  const off = t.c.pubsub.subscribe(channel, (m) => got.push(m as { type: string; id?: string }));
  return { got, off };
}

describe('live notifications', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('an org-wide notification is published on the org channel with only its ID, after it is saved', async () => {
    const org = await createOrg(t.c, 'Live Co');
    const org$ = listen(t, orgChannel(org.orgId));
    await send(t, org, 'talk to a human');
    await t.c.automation.dispatchPending();
    const published = org$.got.filter((m) => m.type === 'notification');
    expect(published).toHaveLength(1);
    expect(Object.keys(published[0]!).sort()).toEqual(['id', 'type']);
    const saved = await t.c.automation.listNotifications(org.scope, null);
    expect(saved.map((n) => n.id)).toContain(published[0]!.id);
    org$.off();
  });

  it("a personal notification goes only to its owner's channel", async () => {
    const org = await createOrg(t.c, 'Personal Co');
    const [owner] = (await t.c.tenancy.listMembers(org.orgId)).filter((m) => m.role === 'owner');
    const sam = await t.c.tenancy.addMember(org.orgId, { email: `sam-${Date.now()}@example.com`, role: 'agent', name: 'Sam', password: 'password-123' });
    const r = await send(t, org, 'talk to a human');
    await t.c.automation.dispatchPending();

    const org$ = listen(t, orgChannel(org.orgId));
    const sam$ = listen(t, userChannel(org.orgId, sam.userId));
    const owner$ = listen(t, userChannel(org.orgId, owner!.userId));
    await t.c.conversations.assign(org.scope, r.conversationId, sam.userId, owner!.userId);
    await t.c.automation.dispatchPending();

    expect(sam$.got.filter((m) => m.type === 'notification')).toHaveLength(1);
    expect(owner$.got).toEqual([]);
    expect(org$.got.filter((m) => m.type === 'notification')).toEqual([]);
    // The inbox list hears about the assignment itself.
    expect(org$.got.map((m) => m.type)).toContain('conversation.assigned');
    [org$, sam$, owner$].forEach((l) => l.off());
  });

  it('playground chats publish nothing', async () => {
    const org = await createOrg(t.c, 'Playground Co');
    const org$ = listen(t, orgChannel(org.orgId));
    const session = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'tester', content: 'talk to a human', isTest: true });
    await t.c.queue.drain();
    await t.c.automation.dispatchPending();
    expect((await t.c.conversations.get(org.scope, session.conversationId)).status).toBe('human_active');
    expect(org$.got.filter((m) => m.type === 'notification')).toEqual([]);
    org$.off();
  });
});
