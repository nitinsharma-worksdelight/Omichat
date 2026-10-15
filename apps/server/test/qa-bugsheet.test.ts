import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_NAME, nextAgentName } from '../../dashboard/src/lib/agentNames';
import { formatNumericDate } from '../../dashboard/src/lib/format';
import { isPhoneLike } from '../../dashboard/src/lib/validate';
import { settingLabel, timingFieldError, timingProblems } from '../../dashboard/src/lib/settingErrors';
import { OpenAIProvider } from '../src/modules/ai/llm/openai';
import { authHeaders, createOrg, createTestEnv, type TestEnv } from './helpers';

/**
 * The QA bug sheet (Omni AI Dashboard): the fixes that live in the server, and the pure checks the dashboard's forms
 * use (they have no React or browser APIs, so they are tested here like the other form checks).
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
const patchBot = (org: Org, body: Record<string, unknown>) => t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: body });

describe('BUG-001: a model the provider does not offer is not saved', () => {
  it('refuses an unknown model on update and on create, naming the field', async () => {
    const org = await createOrg(t.c, 'Model Co');
    t.llm.catalog = ['good-model', 'another-model'];
    try {
      const bad = await patchBot(org, { model: 'not-a-real-model', maxOutputTokens: 2000 });
      expect(bad.statusCode, bad.body).toBe(400);
      expect(bad.json().error.details[0]).toMatchObject({ path: 'model', message: expect.stringContaining('not-a-real-model') });
      // Nothing was saved with it: not the model, and not the version.
      const kept = (await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token) })).json();
      expect(kept).toMatchObject({ model: null, version: org.bot.version });

      const created = await t.app.inject({ method: 'POST', url: '/v1/bots', headers: authHeaders(org.token), payload: { name: 'Bad Model Agent', model: 'nope' } });
      expect(created.statusCode).toBe(400);
      expect((await t.app.inject({ method: 'GET', url: '/v1/bots', headers: authHeaders(org.token) })).json().some((b: { name: string }) => b.name === 'Bad Model Agent')).toBe(false);
    } finally {
      t.llm.catalog = null;
    }
  });

  it('accepts a model the provider offers, and clearing the override', async () => {
    const org = await createOrg(t.c, 'Good Model Co');
    t.llm.catalog = ['good-model'];
    try {
      const ok = await patchBot(org, { model: 'good-model' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().model).toBe('good-model');
      const cleared = await patchBot(org, { model: null });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().model).toBeNull();
    } finally {
      t.llm.catalog = null;
    }
  });

  it('does not hold up other changes to a bot whose stored model has since been withdrawn', async () => {
    const org = await createOrg(t.c, 'Withdrawn Model Co');
    t.llm.catalog = ['soon-gone'];
    expect((await patchBot(org, { model: 'soon-gone' })).statusCode).toBe(200);
    t.llm.catalog = [];
    try {
      // The model isn't sent again, so it isn't asked about again.
      const rename = await patchBot(org, { name: 'Renamed' });
      expect(rename.statusCode, rename.body).toBe(200);
    } finally {
      t.llm.catalog = null;
    }
  });

  it("when the provider can't say (down, key rejected, custom endpoint), a save is not blocked", async () => {
    const org = await createOrg(t.c, 'Unknown Model Co');
    t.llm.catalog = null;
    expect((await patchBot(org, { model: 'any-model-name' })).statusCode).toBe(200);
    // A provider that throws is treated the same way.
    const original = t.llm.modelExists;
    t.llm.modelExists = async () => {
      throw new Error('network down');
    };
    try {
      expect((await patchBot(org, { model: 'another-name' })).statusCode).toBe(200);
    } finally {
      t.llm.modelExists = original;
    }
  });

  it('a custom OpenAI endpoint is never asked (it may not list models)', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test', baseURL: 'http://127.0.0.1:1/v1', timeoutMs: 1000, defaults: { model: 'gpt-x' } });
    expect(await provider.modelExists('whatever')).toBeNull();
  });
});

describe('BUG-002: Timing & Pacing numbers are checked where they are typed', () => {
  it('says what is allowed, in plain words', () => {
    expect(timingFieldError('maxAiReplies', 20)).toBeNull();
    expect(timingFieldError('maxAiReplies', 1)).toBeNull();
    expect(timingFieldError('maxAiReplies', 500)).toBeNull();
    for (const bad of [-5, 0, 501, 2.5, Number.NaN]) expect(timingFieldError('maxAiReplies', bad), String(bad)).toBe('Enter a whole number between 1 and 500.');
    expect(timingFieldError('waitMinutes', 0)).toBeNull();
    expect(timingFieldError('waitMinutes', 1440)).toBeNull();
    for (const bad of [-1, 1441, 99_999_999]) expect(timingFieldError('waitMinutes', bad), String(bad)).toBe('Enter a whole number between 0 and 1440 (0 means never).');
  });

  it("lists every bad number together, named as the person sees them (never `guardrails.maxAiRepliesPerConversation`)", async () => {
    const org = await createOrg(t.c, 'Timing Co');
    const config = JSON.parse(JSON.stringify((await t.c.bots.get(org.scope, org.bot.id)).config));
    config.guardrails.maxAiRepliesPerConversation = -5;
    config.handoff.waitMinutes = 99_999_999;
    const problems = timingProblems(config);
    expect(problems.map((p) => p.path).sort()).toEqual(['guardrails.maxAiRepliesPerConversation', 'handoff.waitMinutes']);
    expect(problems.map((p) => settingLabel(p.path)).sort()).toEqual(['If nobody answers a handoff (minutes)', 'Max AI replies per conversation']);
    config.guardrails.maxAiRepliesPerConversation = 20;
    config.handoff.waitMinutes = 30;
    expect(timingProblems(config)).toEqual([]);
  });

  it('names the other settings a save can complain about, and any unknown one in words', () => {
    expect(settingLabel('config.business.website')).toBe('Website');
    expect(settingLabel('model')).toBe('Model');
    expect(settingLabel('config')).toBe('');
    expect(settingLabel('handoff.someNewSetting')).toBe('Some new setting');
  });

  it('the server still refuses the same numbers, so a stale browser cannot save them', async () => {
    const org = await createOrg(t.c, 'Timing Server Co');
    const config = (await t.c.bots.get(org.scope, org.bot.id)).config;
    expect((await patchBot(org, { config: { guardrails: { ...config.guardrails, maxAiRepliesPerConversation: -5 } } })).statusCode).toBe(400);
    expect((await patchBot(org, { config: { handoff: { ...config.handoff, waitMinutes: 99_999_999 } } })).statusCode).toBe(400);
  });
});

describe('BUG-008: dates beside a date picker read the way the picker does', () => {
  it('is numeric, in the browser order, and the same day whatever the time zone', () => {
    const expected = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(2026, 8, 15));
    expect(formatNumericDate('2026-09-15')).toBe(expected);
    expect(formatNumericDate('2026-09-15')).toMatch(/15/);
    expect(formatNumericDate('2026-09-15')).not.toMatch(/T|[A-Za-z]/);
    // Year-end and month-end don't slip a day.
    expect(formatNumericDate('2026-12-31')).toMatch(/31/);
    expect(formatNumericDate('2026-01-01')).toMatch(/01|1/);
  });

  it('leaves what is not a date as it came', () => {
    expect(formatNumericDate('')).toBe('');
    expect(formatNumericDate('soon')).toBe('soon');
  });
});

describe('BUG-012: the Add contact form checks the phone with the email', () => {
  it('rejects text that is not a phone number, accepts the usual ways of writing one', () => {
    for (const bad of ['abc', '12', 'phone', '++', 'x1']) expect(isPhoneLike(bad), bad).toBe(false);
    for (const ok of ['+1 416 555 0100', '(416) 555-0100', '416.555.0100', '+91 98765 43210']) expect(isPhoneLike(ok), ok).toBe(true);
  });
});

describe('BUG-014: a custom field key with a trailing underscore cannot be created', () => {
  it('is refused on the server, so an existing "bad_key_" can only be old test data', async () => {
    const org = await createOrg(t.c, 'Field Key Co');
    for (const key of ['bad_key_', '_bad', 'bad__key']) {
      const res = await t.app.inject({ method: 'POST', url: '/v1/custom-fields', headers: authHeaders(org.token), payload: { key, label: 'QA Budget (INR)' } });
      expect(res.statusCode, key).toBe(400);
    }
    const ok = await t.app.inject({ method: 'POST', url: '/v1/custom-fields', headers: authHeaders(org.token), payload: { key: 'qa_budget_inr', label: 'QA Budget (INR)' } });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});

describe('BUG-003: a new agent is "Untitled <number>"', () => {
  it('starts at 1 and counts up', () => {
    expect(DEFAULT_AGENT_NAME).toBe('Untitled');
    expect(nextAgentName([])).toBe('Untitled 1');
    expect(nextAgentName(['Untitled 1'])).toBe('Untitled 2');
    expect(nextAgentName(['Untitled 1', 'Untitled 2'])).toBe('Untitled 3');
  });

  it("goes one past the highest number, so a deleted agent's number isn't handed out again", () => {
    expect(nextAgentName(['Untitled 1', 'Untitled 3'])).toBe('Untitled 4');
    expect(nextAgentName(['Untitled 2'])).toBe('Untitled 3');
    expect(nextAgentName(['Untitled 9', 'Untitled 10'])).toBe('Untitled 11');
  });

  it('ignores names that only look similar, and is not thrown by case or spaces', () => {
    expect(nextAgentName(['Website Assistant', 'Untitled', 'Untitled 2 copy', 'Old Untitled 5', 'Untitled 1a'])).toBe('Untitled 1');
    expect(nextAgentName(['  untitled 4  '])).toBe('Untitled 5');
    // Renamed agents leave their number free only when no other agent holds a higher one.
    expect(nextAgentName(['Pizza Bot', 'Untitled 7'])).toBe('Untitled 8');
  });

  it('what it makes is a name the server accepts, many times over', async () => {
    const org = await createOrg(t.c, 'Agent Names Co');
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const existing = (await t.app.inject({ method: 'GET', url: '/v1/bots', headers: authHeaders(org.token) })).json().map((b: { name: string }) => b.name);
      const name = nextAgentName(existing);
      const res = await t.app.inject({ method: 'POST', url: '/v1/bots', headers: authHeaders(org.token), payload: { name } });
      expect(res.statusCode, res.body).toBe(201);
      names.push(res.json().name);
    }
    expect(names).toEqual(['Untitled 1', 'Untitled 2', 'Untitled 3']);
  });
});

