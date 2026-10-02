import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { schema } from '../src/db/client';
import { parseInput } from '../src/lib/validation';
import { authHeaders, createOrg, createTestEnv, type TestEnv } from './helpers';

/**
 * Q3 — forms say what's wrong next to the field, and the server refuses the same mistakes: business contact details
 * the bot hands out, empty contacts, negative deal values, tasks due in the past and custom field keys that can't
 * be fixed later.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv(); // the clock is fixed at Monday 28 September 2026, 13:00 UTC
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
type Detail = { path: string; message: string };
const call = (token: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: authHeaders(token), ...(payload ? { payload } : {}) });
const detailsOf = (res: { json: () => unknown }) => (res.json() as { error: { details: Detail[] } }).error.details;

async function apiKey(org: Org, scopes: string[]) {
  const res = await call(org.token, 'POST', '/v1/api-keys', { name: `key-${scopes.join('+')}`, scopes });
  expect(res.statusCode).toBe(201);
  return (res.json() as { key: string }).key;
}

describe('friendly validation messages', () => {
  const parse = (s: z.ZodType, data: unknown) => {
    try {
      parseInput(s, data);
      return [];
    } catch (err) {
      return (err as { details: Detail[] }).details.map((d) => `${d.path}: ${d.message}`);
    }
  };

  it('replace the built-in messages in plain words', () => {
    const s = z.object({
      value: z.number().nonnegative().max(10),
      name: z.string().trim().min(1).max(3),
      email: z.string().email(),
      site: z.string().url(),
      when: z.coerce.date(),
      kind: z.enum(['a', 'b']),
      tags: z.array(z.string()).min(1),
    });
    expect(parse(s, { value: -5, name: '', email: 'x', site: 'nope', when: 'garbage', kind: 'c', tags: [] })).toEqual([
      "value: Can't be negative",
      'name: Required',
      'email: Enter a valid email address',
      'site: Enter a valid web address',
      'when: Enter a valid date',
      'kind: Must be one of: a, b',
      'tags: Add at least 1',
    ]);
    expect(parse(s, { value: 11, name: 'long', email: 'a@b.co', site: 'https://a.co', when: '2026-01-01', kind: 'a', tags: ['x'] })).toEqual([
      'value: Must be at most 10',
      'name: Must be at most 3 characters',
    ]);
    expect(parse(s, {})[0]).toBe('value: Required');
  });

  it("never replace a schema's own message", () => {
    expect(parse(z.object({ key: z.string().regex(/^[a-z]+$/, 'use lowercase letters') }), { key: 'A!' })).toEqual(['key: use lowercase letters']);
  });
});

describe('business info (BUG-04)', () => {
  const patchBusiness = (org: Org, business: Record<string, string>) =>
    call(org.token, 'PATCH', `/v1/bots/${org.bot.id}`, { config: { business: { ...org.bot.config.business, ...business } } });

  it('refuses a website, email or phone the bot could not hand out, naming the field', async () => {
    const org = await createOrg(t.c, 'Business Clinic');
    const res = await patchBusiness(org, { website: 'not a url', email: 'bad-email', phone: 'call us' });
    expect(res.statusCode).toBe(400);
    expect(detailsOf(res)).toEqual([
      { path: 'business.website', message: 'Enter a valid website, e.g. https://example.com' },
      { path: 'business.email', message: 'Enter a valid email address' },
      { path: 'business.phone', message: 'Enter a valid phone number' },
    ]);
  });

  it('accepts valid details and empty ones', async () => {
    const org = await createOrg(t.c, 'Valid Clinic');
    expect((await patchBusiness(org, { website: 'brightsmile.example.com', email: 'hello@brightsmile.example.com', phone: '(416) 555-0123 ext. 4' })).statusCode).toBe(200);
    expect((await patchBusiness(org, { website: 'https://brightsmile.example.com/contact', email: '', phone: '' })).statusCode).toBe(200);
  });

  it('keeps a bot that already stores a bad value working', async () => {
    const org = await createOrg(t.c, 'Old Clinic');
    // Saved before these checks existed.
    const [row] = await t.c.db.select().from(schema.bots).where(eq(schema.bots.id, org.bot.id));
    const config = row!.config;
    await t.c.db.update(schema.bots).set({ config: { ...config, business: { ...config.business, email: 'bad-email' } } }).where(eq(schema.bots.id, org.bot.id));

    expect((await call(org.token, 'GET', `/v1/bots/${org.bot.id}`)).statusCode).toBe(200);
    const persona = { ...org.bot.config.persona, personality: 'Calm' };
    expect((await call(org.token, 'PATCH', `/v1/bots/${org.bot.id}`, { config: { persona } })).statusCode).toBe(200);
    // Saving business info again with the same value is fine too; changing it to another bad one isn't.
    const business = { ...org.bot.config.business, email: 'bad-email' };
    expect((await call(org.token, 'PATCH', `/v1/bots/${org.bot.id}`, { config: { business } })).statusCode).toBe(200);
    expect((await call(org.token, 'PATCH', `/v1/bots/${org.bot.id}`, { config: { business: { ...business, email: 'still-bad' } } })).statusCode).toBe(400);
  });
});

describe('adding a contact (BUG-05)', () => {
  it('needs a name, email or phone from staff', async () => {
    const org = await createOrg(t.c, 'Contacts Clinic');
    for (const body of [{}, { firstName: '  ' }, { company: 'Acme' }]) {
      const res = await call(org.token, 'POST', '/v1/contacts', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(detailsOf(res)).toEqual([{ path: 'firstName', message: 'Add a name, email or phone' }]);
    }
    expect((await call(org.token, 'POST', '/v1/contacts', { firstName: 'Walk' })).statusCode).toBe(201);
  });

  it('names the field when the email is not valid', async () => {
    const org = await createOrg(t.c, 'Email Clinic');
    const res = await call(org.token, 'POST', '/v1/contacts', { email: 'bad' });
    expect(res.statusCode).toBe(400);
    expect(detailsOf(res)).toEqual([{ path: 'email', message: 'Enter a valid email address' }]);
  });

  it('still lets an integration start an anonymous contact', async () => {
    const org = await createOrg(t.c, 'Integration Clinic');
    const key = await apiKey(org, ['contacts:write']);
    const res = await t.app.inject({ method: 'POST', url: '/v1/contacts', headers: { authorization: `Bearer ${key}` }, payload: { source: { utm_source: 'ads' } } });
    expect(res.statusCode).toBe(201);
  });
});

describe('deal value (BUG-08)', () => {
  it('says plainly that a value cannot be negative', async () => {
    const org = await createOrg(t.c, 'Deals Clinic');
    const contactId = (await t.c.contacts.create(org.scope, { firstName: 'Ana' })).id;
    const res = await call(org.token, 'POST', '/v1/deals', { title: 'Ana deal', contactId, value: -500 });
    expect(res.statusCode).toBe(400);
    expect(detailsOf(res)).toEqual([{ path: 'value', message: "Can't be negative" }]);
  });
});

describe('task due dates (BUG-09)', () => {
  it('refuses a past due date from staff, but not today', async () => {
    const org = await createOrg(t.c, 'Tasks Clinic');
    const past = await call(org.token, 'POST', '/v1/tasks', { title: 'QA task past due', dueAt: '2020-01-01T09:00:00.000Z' });
    expect(past.statusCode).toBe(400);
    expect(detailsOf(past)).toEqual([{ path: 'dueAt', message: "Due date can't be in the past" }]);
    // 09:00 today in Toronto is already past at 13:00 UTC (09:00 there): still allowed.
    expect((await call(org.token, 'POST', '/v1/tasks', { title: 'Call back', dueAt: '2026-09-28T09:00:00-04:00' })).statusCode).toBe(201);
    expect((await call(org.token, 'POST', '/v1/tasks', { title: 'No date' })).statusCode).toBe(201);
  });

  it('lets an integration import an old task, and an overdue task can still be ticked off', async () => {
    const org = await createOrg(t.c, 'Import Clinic');
    const key = await apiKey(org, ['contacts:write']);
    const imported = await t.app.inject({ method: 'POST', url: '/v1/tasks', headers: { authorization: `Bearer ${key}` }, payload: { title: 'Old', dueAt: '2020-01-01T09:00:00.000Z' } });
    expect(imported.statusCode).toBe(201);
    const id = (imported.json() as { id: string }).id;
    expect((await call(org.token, 'PATCH', `/v1/tasks/${id}`, { status: 'done' })).statusCode).toBe(200);
  });
});

describe('custom field keys (BUG-12)', () => {
  it('refuses keys with stray underscores, and the key still cannot be changed', async () => {
    const org = await createOrg(t.c, 'Fields Clinic');
    for (const key of ['bad_key_', '_x', 'a__b']) {
      const res = await call(org.token, 'POST', '/v1/custom-fields', { key, label: 'QA Budget' });
      expect(res.statusCode, key).toBe(400);
      expect(detailsOf(res)[0]).toMatchObject({ path: 'key' });
    }
    const created = await call(org.token, 'POST', '/v1/custom-fields', { key: 'bad_key', label: 'QA Budget' });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    const renamed = await call(org.token, 'PATCH', `/v1/custom-fields/${id}`, { key: 'other', label: 'QA Budget 2' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ key: 'bad_key', label: 'QA Budget 2' });
  });
});
