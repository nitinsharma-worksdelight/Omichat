import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemo } from '../src/db/seed';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

/**
 * F1 — Bot personality: the business's own goals and a personality in its own words reach the model; bots that
 * don't use them keep exactly the same prompt; an empty company name falls back to the organization's name.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;

const patchBot = (org: Org, config: Record<string, unknown>, botId = org.bot.id) =>
  t.app.inject({ method: 'PATCH', url: `/v1/bots/${botId}`, headers: authHeaders(org.token), payload: { config } });

async function promptOf(org: Org, botId = org.bot.id): Promise<string> {
  const res = await t.app.inject({ method: 'GET', url: `/v1/bots/${botId}/preview`, headers: authHeaders(org.token) });
  expect(res.statusCode).toBe(200);
  return (res.json() as { system: string }).system;
}

const NO_PRESSURE =
  'Work towards these goals when it helps the customer: answer their question first, suggest the next step naturally, and never pressure them or repeat an offer they declined.';

describe('goals', () => {
  it("puts the business's own goals first, with a line against pressure", async () => {
    const org = await createOrg(t.c, 'Goal Clinic');
    const res = await patchBot(org, {
      goals: { primary: 'Get visitors to book\n a free consultation.', secondary: ['Mention the new-patient offer when it fits.', '  '] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.goals).toEqual({
      primary: 'Get visitors to book a free consultation.',
      secondary: ['Mention the new-patient offer when it fits.'],
    });
    const system = await promptOf(org);
    expect(system).toContain(
      [
        '## Your goals',
        '- Main goal: Get visitors to book a free consultation.',
        '- Mention the new-patient offer when it fits.',
        '- Answer questions about the business accurately, using only the information you are given.',
      ].join('\n'),
    );
    expect(system).toContain(NO_PRESSURE);
  });

  it('adds nothing when the business set no goals', async () => {
    const org = await createOrg(t.c, 'Plain Clinic');
    const system = await promptOf(org);
    expect(system).not.toContain('Main goal');
    expect(system).not.toContain(NO_PRESSURE);
  });
});

describe('personality', () => {
  it("adds the business's own description of the voice under the tone", async () => {
    const org = await createOrg(t.c, 'Voice Clinic');
    const personality = 'Warm and reassuring, a little playful, like our front desk.';
    expect((await patchBot(org, { persona: { ...org.bot.config.persona, personality } })).statusCode).toBe(200);
    expect(await promptOf(org)).toContain(
      `- Tone: warm and friendly. Keep replies short: one or two sentences. This is a limit, not a target: go past two only when the customer asks for detail or a list.\n- Personality: ${personality}`,
    );
  });
});

describe('bots that use none of this', () => {
  // Taken before F1. When a later phase changes the prompt on purpose, update it with `vitest -u` and say so.
  it('keep exactly the same system prompt', async () => {
    const env = await createTestEnv();
    try {
      const { orgId } = await seedDemo(env.c);
      const { token } = await env.c.auth.login({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
      const [bot] = await env.c.bots.list({ orgId });
      const res = await env.app.inject({ method: 'GET', url: `/v1/bots/${bot!.id}/preview`, headers: authHeaders(token) });
      expect((res.json() as { system: string }).system).toMatchSnapshot();
    } finally {
      await env.close();
    }
  });
});

describe('company name', () => {
  it("falls back to the organization's name in the prompt and the widget", async () => {
    const org = await createOrg(t.c, 'Fallback Dental');
    // A bot created in the dashboard starts without a company name.
    const created = await t.app.inject({ method: 'POST', url: '/v1/bots', headers: authHeaders(org.token), payload: { name: 'Second bot' } });
    expect(created.json().config.persona.companyName).toBe('');
    expect(await promptOf(org, created.json().id)).toMatch(/^You are Ava, the virtual assistant for Fallback Dental\. You chat with Fallback Dental's customers/);

    // The widget's own bot, with its company name cleared.
    expect((await patchBot(org, { persona: { ...org.bot.config.persona, companyName: '' } })).statusCode).toBe(200);
    const config = await t.app.inject({ method: 'GET', url: `/widget/v1/config?key=${org.webchat.publicKey}` });
    expect(config.json().companyName).toBe('Fallback Dental');
  });
});

describe('limits', () => {
  it('refuses goals and a personality that are too long, naming the field', async () => {
    const org = await createOrg(t.c, 'Limit Clinic');
    const longGoal = await patchBot(org, { goals: { primary: 'x'.repeat(301), secondary: [] } });
    expect(longGoal.statusCode).toBe(400);
    expect(JSON.stringify(longGoal.json())).toContain('goals.primary');

    const sixGoals = await patchBot(org, { goals: { primary: '', secondary: ['a', 'b', 'c', 'd', 'e', 'f'] } });
    expect(sixGoals.statusCode).toBe(400);
    expect(JSON.stringify(sixGoals.json())).toContain('goals.secondary');

    const longVoice = await patchBot(org, { persona: { ...org.bot.config.persona, personality: 'y'.repeat(601) } });
    expect(longVoice.statusCode).toBe(400);
    expect(JSON.stringify(longVoice.json())).toContain('persona.personality');
  });
});

describe('end to end', () => {
  it('the model receives the goals and the fallback company name saved through the API', async () => {
    const org = await createOrg(t.c, 'Relay Clinic');
    const saved = await patchBot(org, {
      persona: { ...org.bot.config.persona, companyName: '' },
      goals: { primary: 'Get visitors to book a free consultation.', secondary: [] },
    });
    expect(saved.statusCode).toBe(200);
    t.llm.setScript([text('Hi!')]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'relay', content: 'Hello' });
    await t.c.queue.drain();
    const system = t.llm.requests.at(-1)!.system;
    expect(system).toContain('- Main goal: Get visitors to book a free consultation.');
    expect(system).toMatch(/^You are Ava, the virtual assistant for Relay Clinic\./);
  });
});
