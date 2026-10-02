import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg } from '../test/helpers';
import { createIntegrationEnv, enabled, flushRedis, type IntegrationEnv } from './helpers';

describe.skipIf(!enabled)('conversation status and unanswered messages (real Postgres + Redis)', () => {
  let t: IntegrationEnv;
  beforeAll(async () => {
    await flushRedis();
    // Three minutes ahead of the database's clock, so a message saved now counts as waiting. No workers: nothing answers.
    t = await createIntegrationEnv({ workers: false, now: new Date(Date.now() + 3 * 60_000) });
  });
  afterAll(async () => t?.close());

  async function startChat(name: string) {
    const org = await createOrg(t.c, name);
    const staffUser = await t.c.auth.userIdFromBearer(org.token);
    const first = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content: 'Hello' });
    return { org, staffUser, id: first.conversationId, messageId: first.message.id };
  }

  it('several people taking a chat over at once change it once (the row is locked)', async () => {
    const { org, staffUser, id } = await startChat('Race Co');
    const takeover = () => t.c.conversations.setStatus(org.scope, id, 'human_active', { actor: 'user', actorUserId: staffUser, reason: 'Taken over by staff' });
    await Promise.all([takeover(), takeover(), takeover(), takeover()]);
    const events = await t.c.conversations.timeline(org.scope, id);
    expect(events.filter((e) => e.type === 'conversation.handoff_requested')).toHaveLength(1);
    expect((await t.c.conversations.get(org.scope, id)).status).toBe('human_active');
  });

  it("an AI message racing a takeover is stored only if the chat was still the AI's", async () => {
    for (let round = 0; round < 10; round++) {
      const { org, staffUser, id } = await startChat(`Guard Race Co ${round}`);
      const [, sent] = await Promise.all([
        t.c.conversations.setStatus(org.scope, id, 'human_active', { actor: 'user', actorUserId: staffUser }),
        t.c.conversations.addOutboundIf(org.scope, { conversationId: id, senderType: 'ai', content: 'AI reply' }, (c) => c.status === 'ai_active'),
      ]);
      const ai = (await t.c.conversations.messages(org.scope, id)).filter((m) => m.senderType === 'ai');
      // Either the reply went out first, or it was refused: never a reply that was refused and stored anyway.
      expect(ai).toHaveLength(sent ? 1 : 0);
      expect((await t.c.conversations.get(org.scope, id)).status).toBe('human_active');
    }
  });

  it('the sweeper finds a waiting message and queues its reply in Redis', async () => {
    const { org, id } = await startChat('Sweep Co');
    expect(await t.c.unansweredSweeper.run()).toBeGreaterThanOrEqual(1);
    expect(await t.c.conversations.unansweredTrigger(org.scope, id)).not.toBeNull();
  });
});
