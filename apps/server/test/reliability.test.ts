import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import type { LockOptions, LockService } from '../src/infra/lock';
import type { MockTurn } from '../src/modules/ai/llm/mock';
import { LlmError } from '../src/modules/ai/llm/types';
import { createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/**
 * A reply must survive a flaky provider, a slow provider and a lost lock without doing anything twice,
 * without leaving the customer waiting forever, and without two replies at once.
 */

async function send(env: TestEnv, org: { orgId: string; webchat: { id: string } }, content: string, visitor = 'visitor') {
  const r = await env.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await env.c.queue.drain();
  return r;
}

async function runsOf(env: TestEnv, orgId: string, conversationId: string) {
  const runs = await env.c.tenantDb.run(orgId, (tx) => tx.select().from(schema.aiRuns).where(eq(schema.aiRuns.conversationId, conversationId)));
  return runs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

const temporaryFailure = (): never => {
  throw new LlmError('unavailable', true, 'Provider overloaded', 'mock');
};

/** A scripted model call that never answers; it only ends when the turn aborts it. */
const hang: MockTurn = (_req, _call, opts) =>
  new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason), { once: true }));

describe('retried turns', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('replay notes, tasks, staff alerts and workflow calls instead of repeating them', async () => {
    const org = await createOrg(t.c, 'Retry Co');
    await t.c.automation.createWorkflow(org.scope, {
      key: 'crm_sync',
      name: 'CRM sync',
      description: 'Send the lead to the CRM',
      url: 'http://127.0.0.1:9/hook',
      mode: 'fire_and_forget',
      inputFields: [],
      timeoutMs: 1000,
      identifiedOnly: false,
      askFirst: false,
      isActive: true,
    });
    await t.c.bots.update(org.scope, org.bot.id, { config: { actions: { workflowKeys: ['crm_sync'] } } });
    const actions = (note: string) =>
      tools(
        { name: 'add_note', input: { note } },
        { name: 'create_task', input: { title: 'Call back about pricing' } },
        { name: 'notify_team', input: { subject: 'Hot lead', message: 'Wants a quote today' } },
        { name: 'trigger_workflow', input: { workflow_key: 'crm_sync', inputs: {} } },
      );
    t.llm.setScript([
      actions('Prefers morning calls'),
      temporaryFailure,
      // The retry starts over and, as models do, words the note differently.
      actions('Likes to be called in the morning'),
      text('Thanks, the team will call you tomorrow morning.'),
    ]);
    const r = await send(t, org, 'I want a quote, call me tomorrow morning');

    expect((await t.c.contacts.listNotes(org.scope, r.contactId)).map((n) => n.body)).toEqual(['Prefers morning calls']);
    expect(await t.c.contacts.listTasks(org.scope, { contactId: r.contactId })).toHaveLength(1);
    const types = (await t.c.automation.listEvents(org.scope, { contactId: r.contactId })).map((e) => e.type);
    expect(types.filter((type) => type === 'team.notified')).toHaveLength(1);
    expect(types.filter((type) => type === 'workflow.triggered')).toHaveLength(1);
    expect((await t.c.conversations.messages(org.scope, r.conversationId)).map((m) => m.senderType)).toEqual(['contact', 'ai']);
    // The retry's calls are on record as replays of the first attempt's.
    const calls = await t.c.conversations.toolInvocations(org.scope, r.conversationId);
    expect(calls.map((c) => `${c.toolName} ${c.status}`)).toEqual([
      'add_note success',
      'create_task success',
      'notify_team success',
      'trigger_workflow success',
      'add_note replayed',
      'create_task replayed',
      'notify_team replayed',
      'trigger_workflow replayed',
    ]);
    expect((await runsOf(t, org.orgId, r.conversationId)).map((run) => run.status)).toEqual(['failed', 'completed']);
  });

  it('a call the earlier attempt never made still runs', async () => {
    const org = await createOrg(t.c, 'Retry Two');
    t.llm.setScript([
      tools({ name: 'add_note', input: { note: 'Has two dogs' } }),
      temporaryFailure,
      tools({ name: 'add_note', input: { note: 'Has two dogs' } }, { name: 'add_note', input: { note: 'Moving in March' } }),
      text('Noted!'),
    ]);
    const r = await send(t, org, 'I have two dogs and I am moving in March');
    const notes = (await t.c.contacts.listNotes(org.scope, r.contactId)).map((n) => n.body);
    expect(notes.sort()).toEqual(['Has two dogs', 'Moving in March']);
  });
});

/** Like a Redis lock that couldn't be renewed: the current holder can be made to lose it. */
class LosableLock implements LockService {
  acquisitions = 0;
  private current: AbortController | null = null;

  async withLock<T>(_key: string, _opts: LockOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.acquisitions++;
    this.current = new AbortController();
    try {
      return await fn(this.current.signal);
    } finally {
      this.current = null;
    }
  }

  lose() {
    this.current?.abort(new Error('lock lost'));
  }
}

describe('losing the conversation lock', () => {
  const lock = new LosableLock();
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv({ locks: lock });
  });
  afterAll(() => t.close());

  it('stops the reply before it acts or answers; the retry answers once', async () => {
    const org = await createOrg(t.c, 'Lock Co');
    t.llm.setScript([
      (req, call, opts) => {
        lock.lose(); // lost while the model was thinking
        return tools({ name: 'add_note', input: { note: 'Must not be saved' } })(req, call);
      },
      text('Here is your answer.'),
    ]);
    const r = await send(t, org, 'hello');
    expect(await t.c.contacts.listNotes(org.scope, r.contactId)).toEqual([]);
    const messages = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(messages.map((m) => `${m.senderType}: ${m.content}`)).toEqual(['contact: hello', 'ai: Here is your answer.']);
    const runs = await runsOf(t, org.orgId, r.conversationId);
    expect(runs.map((run) => run.status)).toEqual(['failed', 'completed']);
    expect(runs[0]!.error).toMatch(/lock/i);
    expect(lock.acquisitions).toBe(2);
  });
});

describe('turn time limit', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv({ env: { AI_TURN_TIMEOUT_MS: '300' } });
  });
  afterAll(() => t.close());

  it('a reply that runs out of time is retried, and the customer gets one answer', async () => {
    const org = await createOrg(t.c, 'Slow Co');
    t.llm.setScript([hang, text('Sorry for the wait. We are open until 5pm.')]);
    const r = await send(t, org, 'When do you close?');
    const messages = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(messages.map((m) => m.senderType)).toEqual(['contact', 'ai']);
    expect(messages[1]!.content).toMatch(/open until 5pm/);
    expect((await t.c.conversations.get(org.scope, r.conversationId)).status).toBe('ai_active');
    const runs = await runsOf(t, org.orgId, r.conversationId);
    expect(runs.map((run) => run.status)).toEqual(['failed', 'completed']);
    expect(runs[0]!.error).toMatch(/300 ms/);
  });

  it('when every attempt runs out of time, the customer gets an apology and a person', async () => {
    const org = await createOrg(t.c, 'Slower Co');
    t.llm.setScript([hang, hang, hang]);
    const r = await send(t, org, 'Anyone there?');
    expect((await t.c.conversations.get(org.scope, r.conversationId)).status).toBe('human_active');
    const messages = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(messages.at(-1)).toMatchObject({ senderType: 'ai', content: expect.stringMatching(/having trouble/) });
    expect((await runsOf(t, org.orgId, r.conversationId)).map((run) => run.status)).toEqual(['failed', 'failed', 'failed']);
  });
});

describe('handoff alerts', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('with notifyTeam off, staff are alerted only when the AI hands off because of an error', async () => {
    const org = await createOrg(t.c, 'Quiet Co');
    await t.c.bots.update(org.scope, org.bot.id, { config: { handoff: { enabled: true, notifyTeam: false } } });

    t.llm.setScript([]);
    const asked = await send(t, org, 'Can I talk to a human please?', 'asked');
    t.llm.setScript([tools({ name: 'transfer_to_human', input: { reason: 'Billing dispute' } }), text('A team member will reply here.')]);
    const transferred = await send(t, org, 'You charged me twice', 'transferred');
    t.llm.setScript([
      () => {
        throw new LlmError('invalid_request', false, 'Bad request', 'mock');
      },
    ]);
    const failed = await send(t, org, 'Hello?', 'failed');

    for (const r of [asked, transferred, failed]) {
      expect((await t.c.conversations.get(org.scope, r.conversationId)).status).toBe('human_active');
    }
    await t.c.automation.dispatchPending();
    const alerts = (await t.c.automation.listNotifications(org.scope, null)).filter((n) => n.type === 'conversation.handoff_requested');
    expect(alerts.map((n) => n.link)).toEqual([`/conversations/${failed.conversationId}`]);
    // Every handoff is still an event, so webhooks (n8n) see all three.
    const handoffs = (await t.c.automation.listEvents(org.scope, {})).filter((e) => e.type === 'conversation.handoff_requested');
    expect(handoffs).toHaveLength(3);
  });
});
