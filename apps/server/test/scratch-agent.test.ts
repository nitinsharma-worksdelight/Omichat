import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCRATCH_PERSONA } from '../../dashboard/src/lib/agentDefaults';
import { buildFollowUpPrompt } from '../src/modules/ai/approval-followup';
import { BotConfigSchema } from '../src/modules/bots/config';
import { authHeaders, createOrg, createTestEnv, type TestEnv } from './helpers';

/**
 * "Start from Scratch" makes an agent with nothing filled in about it (no name, tone, reply length, greeting or emoji
 * rule): the prompt says nothing about those, so what the owner writes in the prompt decides. Every other way of making
 * an agent, and every agent made before, keeps the defaults it had.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
const create = (org: Org, config: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/v1/bots', headers: authHeaders(org.token), payload: { name: 'Untitled 1', config } });
const preview = async (org: Org, id: string) =>
  ((await t.app.inject({ method: 'GET', url: `/v1/bots/${id}/preview`, headers: authHeaders(org.token) })).json() as { system: string }).system;

describe('a Start from Scratch agent', () => {
  it('is created with no name, tone, reply length, greeting or emoji rule, and keeps the safety defaults', async () => {
    const org = await createOrg(t.c, 'Scratch Defaults Co');
    const res = await create(org, { persona: SCRATCH_PERSONA });
    expect(res.statusCode, res.body).toBe(201);
    const { persona, guardrails } = res.json().config;
    expect(persona).toMatchObject({ assistantName: '', tone: null, responseLength: null, greeting: '', useEmojis: null });
    expect(guardrails).toMatchObject({ stayOnTopic: true, unknownAnswer: 'collect_contact' });
  });

  it('its prompt names no agent and says nothing about tone, length or emojis', async () => {
    const org = await createOrg(t.c, 'Scratch Prompt Co');
    const bot = (await create(org, { persona: SCRATCH_PERSONA })).json();
    const system = await preview(org, bot.id);
    expect(system.split('\n')[0]).toBe("You are the virtual assistant for the business. You chat with the business's customers and prospects on its behalf.");
    expect(system).not.toMatch(/\bAva\b/);
    expect(system).not.toMatch(/^- Tone:/m);
    expect(system).not.toMatch(/Keep replies short|Keep replies concise|well-organized answers/);
    expect(system).not.toMatch(/Do not use emojis|occasional emoji/);
    // The rest of the guidance and the safety rules are still there.
    expect(system).toContain("Reply in the language the customer writes in.");
    expect(system).toContain('Stay on topic: the business and what it offers');
  });

  it("the prompt box's own name, tone and emoji rules are the only ones the model gets", async () => {
    const org = await createOrg(t.c, 'Scratch Sarah Co');
    const bot = (await create(org, { persona: SCRATCH_PERSONA, instructions: 'You are Sarah. Be playful and use emojis.' })).json();
    const system = await preview(org, bot.id);
    expect(system).toContain('You are Sarah. Be playful and use emojis.');
    expect(system.match(/\bYou are [A-Z][a-z]+\b/g)).toEqual(['You are Sarah']);
    expect(system).not.toMatch(/Do not use emojis/);
  });

  it('the chat shows "Assistant" and a plain greeting until the owner sets a name, never the organization name', async () => {
    const org = await createOrg(t.c, 'Scratch Widget Co');
    const patch = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { persona: SCRATCH_PERSONA } } });
    expect(patch.statusCode, patch.body).toBe(200);
    const config = (await t.app.inject({ method: 'GET', url: `/widget/v1/config?key=${org.webchat.publicKey}` })).json();
    expect(config).toMatchObject({ assistantName: 'Assistant', companyName: '', greeting: 'Hi! How can I help?' });
    expect(config.theme.title).toBeUndefined();
    const playground = (await t.app.inject({ method: 'POST', url: `/v1/bots/${org.bot.id}/playground`, headers: authHeaders(org.token) })).json();
    expect(playground).toMatchObject({ botName: 'Assistant', greeting: 'Hi! How can I help?' });

    // A business name the owner typed is what the chat shows as the business; an agent name is the agent's.
    await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { persona: { ...SCRATCH_PERSONA, companyName: 'Smile Dental' } } } });
    expect((await t.app.inject({ method: 'GET', url: `/widget/v1/config?key=${org.webchat.publicKey}` })).json()).toMatchObject({ assistantName: 'Assistant', companyName: 'Smile Dental' });
    await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { persona: { ...SCRATCH_PERSONA, assistantName: 'Sarah', greeting: 'Welcome!' } } } });
    expect((await t.app.inject({ method: 'GET', url: `/widget/v1/config?key=${org.webchat.publicKey}` })).json()).toMatchObject({ assistantName: 'Sarah', greeting: 'Welcome!' });
  });

  it('no business name is ever filled in from the organization: the prompt, the custom value and the chat all leave it out', async () => {
    const org = await createOrg(t.c, 'Org Only Name Co');
    const bot = (await create(org, { persona: SCRATCH_PERSONA, instructions: 'We are {business_name}, the team at {business_name}.' })).json();
    const system = await preview(org, bot.id);
    expect(system).not.toContain('Org Only Name Co');
    expect(system.split('\n')[0]).toBe("You are the virtual assistant for the business. You chat with the business's customers and prospects on its behalf.");
    expect(system).toContain('We are not set, the team at not set.');
    const config = (await t.app.inject({ method: 'GET', url: `/widget/v1/config?key=${org.webchat.publicKey}` })).json();
    expect(JSON.stringify(config)).not.toContain('Org Only Name Co');
    const playground = (await t.app.inject({ method: 'POST', url: `/v1/bots/${bot.id}/playground`, headers: authHeaders(org.token) })).json();
    expect(JSON.stringify(playground)).not.toContain('Org Only Name Co');
  });

  it('settings filled in later reach the prompt, and can be cleared again', async () => {
    const org = await createOrg(t.c, 'Scratch Later Co');
    const bot = (await create(org, { persona: SCRATCH_PERSONA })).json();
    const set = { ...SCRATCH_PERSONA, assistantName: 'Nova', tone: 'professional', responseLength: 'medium', useEmojis: false };
    expect((await t.app.inject({ method: 'PATCH', url: `/v1/bots/${bot.id}`, headers: authHeaders(org.token), payload: { config: { persona: set } } })).statusCode).toBe(200);
    let system = await preview(org, bot.id);
    expect(system).toContain('You are Nova, the virtual assistant');
    expect(system).toContain('- Tone: polished and professional. Keep replies concise');
    expect(system).toContain('- Do not use emojis.');

    expect((await t.app.inject({ method: 'PATCH', url: `/v1/bots/${bot.id}`, headers: authHeaders(org.token), payload: { config: { persona: { ...set, tone: null } } } })).statusCode).toBe(200);
    system = await preview(org, bot.id);
    expect(system).toContain('- Keep replies concise');
    expect(system).not.toMatch(/Tone:/);
  });

  it("the team-approval follow-up doesn't invent a name or tone either", async () => {
    const org = await createOrg(t.c, 'Scratch Followup Co');
    const bot = (await create(org, { persona: SCRATCH_PERSONA })).json();
    const { system } = buildFollowUpPrompt(bot, 'the business', { tool: 'book_appointment', outcome: 'approved', summary: 'Book a visit', reason: null, result: {} }, []);
    expect(system.split('\n')[0]).toBe('You are the virtual assistant for the business, chatting with a customer.');
    expect(system).not.toMatch(/Tone:|Keep replies/);
  });
});

describe('everything else keeps its defaults', () => {
  it('an agent created without persona settings (API, other agent types) still gets Ava, friendly, short, no emojis', async () => {
    const org = await createOrg(t.c, 'Defaults Kept Co');
    const bot = (await create(org, {})).json();
    expect(bot.config.persona).toMatchObject({ assistantName: 'Ava', tone: 'friendly', responseLength: 'short', useEmojis: false, greeting: 'Hi! How can I help you today?' });
    const system = await preview(org, bot.id);
    expect(system).toContain('You are Ava, the virtual assistant for the business.');
    expect(system).toContain('- Tone: warm and friendly. Keep replies short');
    expect(system).toContain('- Do not use emojis.');
  });

  it('a stored config without these fields reads with the old defaults', () => {
    expect(BotConfigSchema.parse({ persona: { assistantName: 'Maya' } }).persona).toMatchObject({ tone: 'friendly', responseLength: 'short', useEmojis: false });
  });

  it('the widget still shows an agent name that is set', async () => {
    const org = await createOrg(t.c, 'Named Agent Co');
    expect((await t.app.inject({ method: 'GET', url: `/widget/v1/config?key=${org.webchat.publicKey}` })).json().assistantName).toBe('Ava');
  });
});
