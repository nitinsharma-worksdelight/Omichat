import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { LockTimeoutError, MemoryLockService, type LockOptions, type LockService } from '../src/infra/lock';
import { isTransientError } from '../src/lib/transient';
import { answers, notice, pendingInbound, type MessageRow } from '../src/modules/conversations/pending';
import { convChannel, type RealtimeEvent } from '../src/modules/conversations/service';
import { createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/**
 * Nobody who writes to the assistant is left without an answer: a message sent while a reply is being written, a
 * question asked while the team had the chat, a job that dies before it can do anything.
 */

type Org = Awaited<ReturnType<typeof createOrg>>;

async function send(env: TestEnv, org: Org, content: string, visitor = 'visitor', externalMessageId?: string) {
  const r = await env.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content, externalMessageId });
  await env.c.queue.drain();
  return r;
}

const thread = async (env: TestEnv, org: Org, id: string) => env.c.conversations.messages(org.scope, id, { limit: 100 });
const speakers = async (env: TestEnv, org: Org, id: string) => (await thread(env, org, id)).map((m) => `${m.senderType}: ${m.content}`);
const status = async (env: TestEnv, org: Org, id: string) => (await env.c.conversations.get(org.scope, id)).status;
const eventsOf = async (env: TestEnv, org: Org, type: string) => (await env.c.automation.listEvents(org.scope, {})).filter((e) => e.type === type);

const row = (id: string, direction: 'inbound' | 'outbound', metadata: Record<string, unknown> = {}): MessageRow => ({ id, direction, metadata });

describe('which messages are still waiting', () => {
  it('everything before a staff message (or an older AI message) is answered', () => {
    const rows = [row('a', 'inbound'), row('b', 'inbound'), row('r', 'outbound'), row('c', 'inbound')];
    expect(pendingInbound(rows).map((r) => r.id)).toEqual(['c']);
  });

  it('a reply that says what it answered leaves a message that arrived while it was written waiting', () => {
    const rows = [row('a', 'inbound'), row('b', 'inbound'), row('r', 'outbound', answers('a'))];
    expect(pendingInbound(rows).map((r) => r.id)).toEqual(['b']);
  });

  it('a reply answers the message it names and everything before it', () => {
    const rows = [row('a', 'inbound'), row('b', 'inbound'), row('c', 'inbound'), row('r', 'outbound', answers('b'))];
    expect(pendingInbound(rows).map((r) => r.id)).toEqual(['c']);
  });

  it("a notice (\"our team hasn't replied\") answers nothing", () => {
    const rows = [row('a', 'inbound'), row('n', 'outbound', notice())];
    expect(pendingInbound(rows).map((r) => r.id)).toEqual(['a']);
  });

  it('a reply naming a message outside the loaded rows answers none of them', () => {
    const rows = [row('a', 'inbound'), row('r', 'outbound', answers('long-ago'))];
    expect(pendingInbound(rows).map((r) => r.id)).toEqual(['a']);
  });

  it('nothing is waiting in an empty or fully answered conversation', () => {
    expect(pendingInbound([])).toEqual([]);
    expect(pendingInbound([row('a', 'inbound'), row('r', 'outbound', answers('a'))])).toEqual([]);
  });
});

describe('temporary failures', () => {
  it('are told apart from failures a retry would only repeat', () => {
    expect(isTransientError(Object.assign(new Error('x'), { code: '40001' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientError(new Error('wrapped', { cause: Object.assign(new Error('x'), { code: '57P01' }) }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(false);
    expect(isTransientError(new Error('boom'))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe('a message sent while the assistant is replying', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('gets its own reply, which comes after the first one and knows about it', async () => {
    const org = await createOrg(t.c, 'Mid Reply Co');
    let second: Promise<unknown> | undefined;
    t.llm.setScript([
      // While the first reply is being written, the customer sends another message.
      async () => {
        second = t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content: 'Also, do you have parking?' });
        await second;
        return text('A root canal removes the infected tissue.')();
      },
      text('Yes, there is free parking at the back.'),
    ]);
    const first = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content: 'What is a root canal?' });
    await t.c.queue.drain();

    const messages = await thread(t, org, first.conversationId);
    const ai = messages.filter((m) => m.senderType === 'ai').map((m) => m.content);
    expect(ai).toEqual(['A root canal removes the infected tissue.', 'Yes, there is free parking at the back.']);
    // The second turn saw the first reply before the question it is answering.
    const request = t.llm.requests[1]!;
    const flat = request.messages.map((m) => `${m.role}: ${m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')}`).join('\n');
    expect(flat.indexOf('What is a root canal?')).toBeLessThan(flat.indexOf('A root canal removes the infected tissue.'));
    expect(flat.indexOf('A root canal removes the infected tissue.')).toBeLessThan(flat.indexOf('Also, do you have parking?'));
    // Nothing is left waiting for the sweeper.
    expect(await t.c.conversations.unansweredTrigger(org.scope, first.conversationId)).toBeNull();
  });

  it('a burst inside the debounce still gets one reply', async () => {
    const env = await createTestEnv({ env: { AI_REPLY_DEBOUNCE_MS: '60' } });
    try {
      const org = await createOrg(env.c, 'Burst Co');
      env.llm.setScript([text('One answer for all three.')]);
      const receive = (content: string) => env.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content });
      const first = await receive('Hi');
      await receive('I have a question');
      await receive('How much is whitening?');
      await env.c.queue.drain();
      expect((await speakers(env, org, first.conversationId)).filter((s) => s.startsWith('ai:'))).toEqual(['ai: One answer for all three.']);
      expect(env.llm.requests).toHaveLength(1);
    } finally {
      await env.close();
    }
  });
});

class CountingLocks implements LockService {
  count = 0;
  private readonly inner = new MemoryLockService();
  withLock<T>(key: string, opts: LockOptions, fn: (signal: AbortSignal) => Promise<T>) {
    this.count++;
    return this.inner.withLock(key, opts, fn);
  }
}

describe('a job whose message already has a newer one behind it', () => {
  it("doesn't queue up for the conversation's lock", async () => {
    const locks = new CountingLocks();
    const env = await createTestEnv({ env: { AI_REPLY_DEBOUNCE_MS: '60' }, locks });
    try {
      const org = await createOrg(env.c, 'No Queue Co');
      env.llm.setScript([text('Both answered here.')]);
      const receive = (content: string) => env.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content });
      await receive('First');
      await receive('Second');
      await env.c.queue.drain();
      expect(locks.count).toBe(1); // the first message's job saw the second and left
      expect(env.llm.requests).toHaveLength(1);
    } finally {
      await env.close();
    }
  });
});

describe('when the last attempt fails outside the model call', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('apologizes, hands the chat to the team and alerts them', async () => {
    const org = await createOrg(t.c, 'Early Failure Co');
    const original = t.c.contacts.getForConversation.bind(t.c.contacts);
    t.c.contacts.getForConversation = async () => {
      throw new Error('contact lookup broke');
    };
    try {
      const r = await send(t, org, 'Do you take new patients?');
      expect(await status(t, org, r.conversationId)).toBe('human_active');
      expect(await speakers(t, org, r.conversationId)).toEqual([
        'contact: Do you take new patients?',
        "ai: Sorry — I'm having trouble right now. A member of our team will reply here shortly.",
      ]);
      const handoff = (await eventsOf(t, org, 'conversation.handoff_requested'))[0]!;
      expect(handoff.payload).toMatchObject({ reason: 'The assistant hit an error', notifyTeam: true });
    } finally {
      t.c.contacts.getForConversation = original;
    }
  });

  it('does the same when the lock never frees up', async () => {
    const stuck: LockService = {
      withLock: async () => {
        throw new LockTimeoutError('conv_x');
      },
    };
    const env = await createTestEnv({ locks: stuck });
    try {
      const org = await createOrg(env.c, 'Stuck Lock Co');
      const r = await send(env, org, 'Hello?');
      expect(await status(env, org, r.conversationId)).toBe('human_active');
      expect((await speakers(env, org, r.conversationId)).at(-1)).toContain("I'm having trouble right now");
    } finally {
      await env.close();
    }
  });

  it('retries a database blip inside the turn instead of giving up at once', async () => {
    const org = await createOrg(t.c, 'Blip Co');
    t.llm.setScript([
      () => {
        throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      },
      text('Sorry about that — we open at 9.'),
    ]);
    const r = await send(t, org, 'When do you open?');
    expect(await status(t, org, r.conversationId)).toBe('ai_active');
    expect(await speakers(t, org, r.conversationId)).toEqual(['contact: When do you open?', 'ai: Sorry about that — we open at 9.']);
  });

  it('hands over at once for an error a retry would only repeat', async () => {
    const org = await createOrg(t.c, 'Hard Failure Co');
    t.llm.setScript([
      () => {
        throw new Error('unexpected state');
      },
    ]);
    const r = await send(t, org, 'Hi');
    expect(await status(t, org, r.conversationId)).toBe('human_active');
    expect(t.llm.requests).toHaveLength(1);
  });
});

describe('an empty reply from the model', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('is tried again, and the customer gets the second answer', async () => {
    const org = await createOrg(t.c, 'Empty Once Co');
    t.llm.setScript([text(''), text('Hello! How can I help?')]);
    const r = await send(t, org, 'Hi');
    expect(await speakers(t, org, r.conversationId)).toEqual(['contact: Hi', 'ai: Hello! How can I help?']);
    const runs = await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.aiRuns).where(eq(schema.aiRuns.conversationId, r.conversationId)));
    expect(runs.map((x) => x.status).sort()).toEqual(['completed', 'failed']);
  });

  it('never leaves the customer in silence: after the last attempt they get an apology and the team is alerted', async () => {
    const org = await createOrg(t.c, 'Always Empty Co');
    t.llm.setScript([text(''), text(''), text('')]);
    const r = await send(t, org, 'Hi');
    expect(await status(t, org, r.conversationId)).toBe('human_active');
    expect((await speakers(t, org, r.conversationId)).at(-1)).toContain("I'm having trouble right now");
  });
});

describe('a saved message whose reply was never queued', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  /** Queueing fails the next time an AI reply is queued, as when the queue's Redis is down at that moment. */
  function failNextReplyQueueing() {
    const queue = t.c.queue;
    const original = queue.add.bind(queue);
    let failed = false;
    queue.add = async (name, data, opts) => {
      if (name === 'ai-reply' && !failed) {
        failed = true;
        throw new Error('redis is down');
      }
      return original(name, data, opts);
    };
    return () => {
      queue.add = original;
    };
  }

  it('is queued by the retry of the same request', async () => {
    const org = await createOrg(t.c, 'Retry Request Co');
    const restore = failNextReplyQueueing();
    try {
      await expect(
        t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content: 'Hi there', externalMessageId: 'client-msg-1' }),
      ).rejects.toThrow('redis is down');
      t.llm.setScript([text('Hello!')]);
      // The widget retries with the same client message id: before, the duplicate was never queued.
      const retry = await send(t, org, 'Hi there', 'v', 'client-msg-1');
      expect(retry.duplicate).toBe(true);
      expect(await speakers(t, org, retry.conversationId)).toEqual(['contact: Hi there', 'ai: Hello!']);
    } finally {
      restore();
    }
  });

  it('is answered by the sweeper when nobody retries', async () => {
    const org = await createOrg(t.c, 'Sweeper Co');
    const restore = failNextReplyQueueing();
    try {
      await expect(
        t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content: 'Anyone there?' }),
      ).rejects.toThrow('redis is down');
    } finally {
      restore();
    }
    const [message] = await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.organizationId, org.orgId)));
    const conversationId = message!.conversationId;

    // Too fresh: it may still be on its way.
    t.now.value = new Date(Date.now() + 30_000);
    expect(await t.c.unansweredSweeper.run()).toBe(0);

    t.llm.setScript([text('Yes, I am here!')]);
    t.now.value = new Date(Date.now() + 3 * 60_000);
    expect(await t.c.unansweredSweeper.run()).toBe(1);
    await t.c.queue.drain();
    expect(await speakers(t, org, conversationId)).toEqual(['contact: Anyone there?', 'ai: Yes, I am here!']);
    // Answered now: left alone.
    expect(await t.c.unansweredSweeper.run()).toBe(0);
  });

  it('leaves alone chats nobody should be answering, and messages that were answered', async () => {
    t.now.value = new Date(Date.now() + 10 * 60_000);
    const org = await createOrg(t.c, 'Sweeper Skips Co');
    // Answered by a person, with the chat theirs.
    const staffUser = await t.c.auth.userIdFromBearer(org.token);
    t.llm.setScript([text('x')]);
    const taken = await send(t, org, 'I need help', 'taken');
    await t.c.conversations.humanReply(org.scope, taken.conversationId, staffUser, 'On my way.');
    // A message that arrived while a reply was written is waiting, not answered: it is the one the sweeper would pick.
    expect(await t.c.unansweredSweeper.run()).toBe(0);

    // AI switched off for the organization: not queued over and over for a reply that can't come.
    const off = await createOrg(t.c, 'Sweeper Off Co');
    await t.c.tenancy.updateOrganization(off.orgId, { aiEnabled: false });
    await send(t, off, 'Hello?', 'off');
    t.now.value = new Date(Date.now() + 10 * 60_000);
    expect(await t.c.unansweredSweeper.run()).toBe(0);
  });
});

describe('a chat handed back to the assistant', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  async function waitingForTeam(name: string, handoff: Record<string, unknown> = {}) {
    const org = await createOrg(t.c, name);
    await t.c.bots.update(org.scope, org.bot.id, { config: { handoff: { enabled: true, ...handoff } } });
    const r = await send(t, org, 'I want to talk to a human');
    expect(await status(t, org, r.conversationId)).toBe('human_active');
    // Asked while the team had the chat, and nobody replied.
    await send(t, org, 'What are your hours on Sunday?');
    return { org, id: r.conversationId };
  }

  it('answers what was asked meanwhile when staff resume it', async () => {
    const { org, id } = await waitingForTeam('Resume Co');
    expect((await speakers(t, org, id)).filter((s) => s.startsWith('ai:'))).toHaveLength(1); // only the handoff message
    t.llm.setScript([text('We are closed on Sundays.')]);
    await t.c.conversations.setStatus(org.scope, id, 'ai_active', { actor: 'user' });
    await t.c.queue.drain();
    expect((await speakers(t, org, id)).at(-1)).toBe('ai: We are closed on Sundays.');
  });

  it("answers it after the team's wait ran out and the fallback put the AI back (the notice is not an answer)", async () => {
    const { org, id } = await waitingForTeam('Fallback Co', { waitMinutes: 15, fallback: 'resume_ai' });
    await t.c.tenantDb.run(org.orgId, (tx) =>
      tx.update(schema.conversations).set({ handedOffAt: new Date(t.now.value.getTime() - 20 * 60_000) }).where(eq(schema.conversations.id, id)),
    );
    t.llm.setScript([text('Sundays we are closed.')]);
    expect(await t.c.handoffWatcher.escalateOverdue()).toBe(1);
    await t.c.queue.drain();
    const lines = await speakers(t, org, id);
    expect(lines.at(-2)).toContain("hasn't been able to reply yet");
    expect(lines.at(-1)).toBe('ai: Sundays we are closed.');
    expect(await status(t, org, id)).toBe('ai_active');
  });

  it("doesn't answer again what a person already answered", async () => {
    const org = await createOrg(t.c, 'Already Answered Co');
    const staffUser = await t.c.auth.userIdFromBearer(org.token);
    const r = await send(t, org, 'Hello');
    await t.c.conversations.humanReply(org.scope, r.conversationId, staffUser, 'Hi, this is Sam.');
    t.llm.setScript([]);
    await t.c.conversations.setStatus(org.scope, r.conversationId, 'ai_active', { actor: 'user' });
    await t.c.queue.drain();
    expect(t.llm.requests).toHaveLength(0);
  });
});

describe('a person taking over, or closing, while the assistant is about to send', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  /** Runs `change` once, at the moment the AI is about to store a message: the narrowest race there is. */
  function raceOnce(change: () => Promise<unknown>) {
    const conversations = t.c.conversations;
    const original = conversations.addOutboundIf.bind(conversations);
    let done = false;
    conversations.addOutboundIf = async (scope, input, allowed) => {
      if (!done && input.senderType === 'ai') {
        done = true;
        await change();
      }
      return original(scope, input, allowed);
    };
    return () => {
      conversations.addOutboundIf = original;
    };
  }

  async function startChat(name: string) {
    const org = await createOrg(t.c, name);
    const staffUser = await t.c.auth.userIdFromBearer(org.token);
    const first = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content: 'Hello' });
    await t.c.queue.drain(); // a first reply, so the next message starts a new turn
    return { org, staffUser, id: first.conversationId };
  }

  it("a normal reply is never sent over a person's takeover", async () => {
    const { org, staffUser, id } = await startChat('Takeover Co');
    const restore = raceOnce(() => t.c.conversations.setStatus(org.scope, id, 'human_active', { actor: 'user', actorUserId: staffUser }));
    try {
      t.llm.setScript([text('The AI wanted to say this.')]);
      await send(t, org, 'Another question');
    } finally {
      restore();
    }
    expect((await speakers(t, org, id)).filter((s) => s.includes('The AI wanted to say this.'))).toEqual([]);
    expect(await status(t, org, id)).toBe('human_active');
  });

  it("a handoff the AI chose never reopens a chat that was closed meanwhile", async () => {
    const { org, id } = await startChat('Closed Meanwhile Co');
    const restore = raceOnce(() => t.c.conversations.setStatus(org.scope, id, 'closed', { actor: 'user' }));
    try {
      t.llm.setScript([tools({ name: 'transfer_to_human', input: { reason: 'Wants a person' } }), text('Connecting you with the team.')]);
      await send(t, org, 'Please get me a person');
    } finally {
      restore();
    }
    expect(await status(t, org, id)).toBe('closed');
    expect((await speakers(t, org, id)).some((s) => s.includes('Connecting you'))).toBe(false);
  });

  it('a staff reply is refused in a closed conversation', async () => {
    const { org, staffUser, id } = await startChat('Closed Reply Co');
    await t.c.conversations.setStatus(org.scope, id, 'closed', { actor: 'user' });
    await expect(t.c.conversations.humanReply(org.scope, id, staffUser, 'Anyone?')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('two people taking over at once change it once', async () => {
    const { org, staffUser, id } = await startChat('Two Takeovers Co');
    const takeover = () => t.c.conversations.setStatus(org.scope, id, 'human_active', { actor: 'user', actorUserId: staffUser, reason: 'Taken over by staff' });
    await Promise.all([takeover(), takeover()]);
    expect(await eventsOf(t, org, 'conversation.handoff_requested')).toHaveLength(1);
  });

  it('onlyFrom keeps the AI from changing a chat that is no longer its own', async () => {
    const { org, id } = await startChat('Only From Co');
    await t.c.conversations.setStatus(org.scope, id, 'closed', { actor: 'user' });
    const row = await t.c.conversations.setStatus(org.scope, id, 'human_active', { actor: 'ai', onlyFrom: ['ai_active'] });
    expect(row.status).toBe('closed');
    expect(await eventsOf(t, org, 'conversation.handoff_requested')).toHaveLength(0);
  });

  it('addOutboundIf stores nothing when the check says no', async () => {
    const { org, id } = await startChat('Guard Co');
    await t.c.conversations.setStatus(org.scope, id, 'human_active', { actor: 'user' });
    const before = (await thread(t, org, id)).length;
    const sent = await t.c.conversations.addOutboundIf(org.scope, { conversationId: id, senderType: 'ai', content: 'late' }, (c) => c.status === 'ai_active');
    expect(sent).toBeNull();
    expect((await thread(t, org, id)).length).toBe(before);
  });
});

describe('the team-wait fallback', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  async function overdue(name: string) {
    const org = await createOrg(t.c, name);
    await t.c.bots.update(org.scope, org.bot.id, { config: { handoff: { enabled: true, waitMinutes: 15, fallback: 'resume_ai' } } });
    const r = await send(t, org, 'I want to talk to a human');
    return { org, id: r.conversationId, claim: { id: r.conversationId, organization_id: org.orgId, wait_minutes: 15, fallback: 'resume_ai' } };
  }
  // The claim step is internal; these tests start at the step after it.
  const escalate = (claim: unknown) => (t.c.handoffWatcher as unknown as { escalate(row: unknown): Promise<void> }).escalate(claim);

  it("does nothing when a person replied between the claim and the fallback", async () => {
    const { org, id, claim } = await overdue('Replied Co');
    const staffUser = await t.c.auth.userIdFromBearer(org.token);
    await t.c.conversations.humanReply(org.scope, id, staffUser, 'Hi, Sam here.');
    await escalate(claim);
    expect(await status(t, org, id)).toBe('human_active');
    expect((await speakers(t, org, id)).some((s) => s.includes("hasn't been able to reply"))).toBe(false);
    expect(await eventsOf(t, org, 'conversation.handoff_overdue')).toHaveLength(0);
  });

  it("does nothing, and doesn't reopen it, when the chat was closed in between", async () => {
    const { org, id, claim } = await overdue('Closed Co');
    await t.c.conversations.setStatus(org.scope, id, 'closed', { actor: 'user' });
    await escalate(claim);
    expect(await status(t, org, id)).toBe('closed');
    expect(await eventsOf(t, org, 'conversation.handoff_overdue')).toHaveLength(0);
  });

  it('a failed fallback is tried again, without alerting the team a second time', async () => {
    const { org, id } = await overdue('Failing Fallback Co');
    await t.c.tenantDb.run(org.orgId, (tx) =>
      tx.update(schema.conversations).set({ handedOffAt: new Date(t.now.value.getTime() - 20 * 60_000) }).where(eq(schema.conversations.id, id)),
    );
    const conversations = t.c.conversations;
    const original = conversations.addOutboundIf.bind(conversations);
    let failures = 1;
    conversations.addOutboundIf = async (...args) => {
      if (failures-- > 0) throw new Error('could not store the message');
      return original(...args);
    };
    try {
      expect(await t.c.handoffWatcher.escalateOverdue()).toBe(1); // alerts, then the fallback fails (logged)
      expect(await status(t, org, id)).toBe('human_active');
      expect(await t.c.handoffWatcher.escalateOverdue()).toBe(1); // claimed again, this time it works
    } finally {
      conversations.addOutboundIf = original;
    }
    await t.c.queue.drain();
    expect(await status(t, org, id)).toBe('ai_active');
    expect(await eventsOf(t, org, 'conversation.handoff_overdue')).toHaveLength(1);
  });
});

describe('when nobody can answer', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  function watch(conversationId: string) {
    const seen: RealtimeEvent[] = [];
    const stop = t.c.pubsub.subscribe(convChannel(conversationId), (e) => seen.push(e as RealtimeEvent));
    return { seen, stop };
  }

  it('a conversation whose bot is gone alerts the team and tells the widget to stop waiting', async () => {
    const org = await createOrg(t.c, 'No Bot Co');
    const first = await send(t, org, 'Hello');
    await t.c.tenantDb.run(org.orgId, (tx) => tx.update(schema.conversations).set({ botId: null }).where(eq(schema.conversations.id, first.conversationId)));
    const { seen, stop } = watch(first.conversationId);
    await send(t, org, 'Anyone there?');
    stop();
    expect((await eventsOf(t, org, 'conversation.unanswered')).map((e) => e.payload)).toEqual([{ reason: 'no_bot' }]);
    expect(seen.some((e) => e.type === 'ai.done' && e.messageId === null)).toBe(true);
  });

  it('a switched-off AI does the same', async () => {
    const org = await createOrg(t.c, 'AI Off Co');
    await t.c.tenancy.updateOrganization(org.orgId, { aiEnabled: false });
    const first = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'v', content: 'Hello' });
    const { seen, stop } = watch(first.conversationId);
    await t.c.queue.drain();
    stop();
    expect((await eventsOf(t, org, 'conversation.unanswered')).map((e) => e.payload)).toEqual([{ reason: 'ai_disabled' }]);
    expect(seen.some((e) => e.type === 'ai.done')).toBe(true);
  });
});

describe('the widget is told whether a reply is coming', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('aiQueued is true while the assistant has the chat, false once a person does', async () => {
    const org = await createOrg(t.c, 'Widget Queued Co');
    const session = (await t.app.inject({ method: 'POST', url: '/widget/v1/sessions', payload: { key: org.webchat.publicKey } })).json() as { token: string };
    const post = (content: string) =>
      t.app.inject({ method: 'POST', url: '/widget/v1/messages', headers: { authorization: `Bearer ${session.token}` }, payload: { content } });
    const first = await post('Hello');
    expect(first.statusCode).toBe(201);
    expect(first.json().aiQueued).toBe(true);
    await t.c.queue.drain();
    await t.c.conversations.setStatus(org.scope, first.json().conversationId, 'human_active', { actor: 'user' });
    const second = await post('Still there?');
    expect(second.json().aiQueued).toBe(false);
    await t.c.queue.drain();
  });
});

describe('the sweeper query', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it("sees a message that arrived mid-reply as unanswered (the AI's reply names an older message)", async () => {
    const org = await createOrg(t.c, 'Sweeper Mid Co');
    const first = await send(t, org, 'First question');
    const [firstMessage] = await thread(t, org, first.conversationId);
    // Back-dated, so the sweeper's reply (stamped now) sorts after all of it: the customer wrote at -60 s, wrote again
    // at -40 s while the reply (stored at -20 s) was still being written. The reply names the first message.
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
    await t.c.tenantDb.run(org.orgId, async (tx) => {
      await tx.update(schema.messages).set({ createdAt: ago(60) }).where(eq(schema.messages.id, firstMessage!.id));
      await tx.insert(schema.messages).values({
        organizationId: org.orgId,
        conversationId: first.conversationId,
        direction: 'inbound',
        senderType: 'contact',
        content: 'Second question',
        createdAt: ago(40),
      });
      await tx
        .update(schema.messages)
        .set({ metadata: answers(firstMessage!.id), createdAt: ago(20) })
        .where(and(eq(schema.messages.conversationId, first.conversationId), eq(schema.messages.direction, 'outbound')));
    });
    t.llm.setScript([text('And here is the second answer.')]);
    t.now.value = new Date(Date.now() + 10 * 60_000);
    expect(await t.c.unansweredSweeper.run()).toBe(1);
    await t.c.queue.drain();
    expect((await speakers(t, org, first.conversationId)).at(-1)).toBe('ai: And here is the second answer.');
    expect(await t.c.unansweredSweeper.run()).toBe(0);
  });
});
