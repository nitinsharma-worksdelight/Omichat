import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clockOffset, noteServerTime, resetClock, serverNow } from '../../dashboard/src/lib/clock';
import { timeAgo } from '../../dashboard/src/lib/format';
import { currentTimezoneName, timezoneChoices } from '../../dashboard/src/lib/timezones';
import { originProblem, reportRangeProblem } from '../../dashboard/src/lib/validate';
import { schema } from '../src/db/client';
import { actionSummary } from '../src/modules/approvals/service';
import { parseLocalStart } from '../src/modules/scheduling/availability';
import { isCountryCode, regionOfTimezone } from '../src/lib/regions';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * The Omni AI Portal bug log (BUG-01 … BUG-22): what the server decides, and the pure rules the dashboard uses.
 * Layout and wording bugs were checked in the browser; their logic is tested here where it has any.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
const call = (org: Org, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: authHeaders(org.token, org.orgId), ...(payload === undefined ? {} : { payload: payload as object }) });

async function say(org: Org, content: string, visitor = 'visitor', opts: { isTest?: boolean } = {}) {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content, ...opts });
  await t.c.queue.drain();
  return r;
}

describe('AI cost is one figure (BUG-01)', () => {
  it("Overview's cost is Analytics' cost for the same days; the budget still counts Test chats", async () => {
    const org = await createOrg(t.c, 'Cost Co');
    t.llm.setScript([text('Hi!'), text('Hi!')]);
    await say(org, 'Hello', 'real');
    await say(org, 'Hello', 'tester', { isTest: true });
    // Both runs happened in the middle of September (the test clock is 28 Sept).
    await t.c.tenantDb.run(org.orgId, (tx) => tx.update(schema.aiRuns).set({ createdAt: new Date('2026-09-15T15:00:00Z') }).where(eq(schema.aiRuns.organizationId, org.orgId)));

    const usage = (await call(org, 'GET', '/v1/usage')).json();
    const month = (await call(org, 'GET', '/v1/analytics?from=2026-09-01&to=2026-09-28')).json();
    const last30 = (await call(org, 'GET', '/v1/analytics?from=2026-08-30&to=2026-09-28')).json();
    expect(usage.aiCostUsd).toBeGreaterThan(0);
    expect(usage.aiCostUsd).toBe(month.aiCostUsd);
    // A longer period that includes the month never reads lower.
    expect(last30.aiCostUsd).toBeGreaterThanOrEqual(usage.aiCostUsd);
    // Everything the AI cost (what the budget counts) includes the Test chat's run.
    expect(usage.ai.costUsd).toBeGreaterThan(usage.aiCostUsd);
  });

  it('is for admins only', async () => {
    const org = await createOrg(t.c, 'Cost Viewer Co');
    const email = `viewer-${Date.now()}@example.com`;
    await t.c.tenancy.addMember(org.orgId, { email, role: 'viewer', name: 'Val', password: 'password-123' });
    const login = await t.c.auth.login({ email, password: 'password-123' });
    const usage = (await t.app.inject({ method: 'GET', url: '/v1/usage', headers: authHeaders(login.token, org.orgId) })).json();
    expect(usage.aiCostUsd).toBeNull();
    expect(usage.ai).toBeNull();
  });
});

describe('a report period that ends before it starts (BUG-02)', () => {
  it('is explained in plain words, by the dashboard and by the API', async () => {
    expect(reportRangeProblem('2026-10-08', '2026-10-01')).toBe('The end date must be on or after the start date.');
    expect(reportRangeProblem('2026-10-01', '2026-10-01')).toBeNull();
    expect(reportRangeProblem('2026-01-01', '2027-06-01')).toBe('Pick a period of 366 days or less.');
    expect(reportRangeProblem('', '2026-10-01')).toBe('Enter both dates.');

    const org = await createOrg(t.c, 'Range Co');
    const res = await call(org, 'GET', '/v1/analytics?from=2026-10-08&to=2026-10-01');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ message: 'The end date must be on or after the start date', details: [{ path: 'to' }] });
    expect(res.body).not.toContain('`to`');
  });
});

describe('adding a contact (BUG-04)', () => {
  it('logs only the details that were really given', async () => {
    const org = await createOrg(t.c, 'Contact Log Co');
    const blank = { firstName: null, lastName: null, email: null, phone: null, company: null };
    expect((await call(org, 'POST', '/v1/contacts', blank)).statusCode).toBe(400);

    const created = await call(org, 'POST', '/v1/contacts', { ...blank, firstName: 'Asha' });
    expect(created.statusCode).toBe(201);
    const events = await t.c.automation.listEvents(org.scope, { contactId: created.json().id });
    const updated = events.filter((e) => e.type === 'contact.updated');
    expect(updated).toHaveLength(1);
    expect((updated[0]!.payload as { changed: string[] }).changed).toEqual(['firstName']);
  });

  it('saving a form that changes nothing records nothing', async () => {
    const org = await createOrg(t.c, 'Contact Same Co');
    const c = await t.c.contacts.create(org.scope, { firstName: 'Ben', email: 'ben@example.com' });
    const before = (await t.c.automation.listEvents(org.scope, { contactId: c.id })).length;
    await call(org, 'PATCH', `/v1/contacts/${c.id}`, { firstName: 'Ben', lastName: null, email: 'ben@example.com', company: null });
    expect((await t.c.automation.listEvents(org.scope, { contactId: c.id })).length).toBe(before);

    await call(org, 'PATCH', `/v1/contacts/${c.id}`, { firstName: 'Benjamin', lastName: null });
    const last = (await t.c.automation.listEvents(org.scope, { contactId: c.id })).find((e) => e.type === 'contact.updated' && (e.payload as { changed: string[] }).changed.includes('firstName') && (e.payload as { source?: string }).source === 'dashboard');
    expect((last!.payload as { changed: string[] }).changed).toEqual(['firstName']);
  });
});

describe('knowledge base names (BUG-06)', () => {
  it('are unique per organization, ignoring case and spaces', async () => {
    const org = await createOrg(t.c, 'KB Names Co');
    const other = await createOrg(t.c, 'KB Names Other Co');
    expect((await call(org, 'POST', '/v1/knowledge-bases', { name: 'Dental FAQs' })).statusCode).toBe(201);
    const dup = await call(org, 'POST', '/v1/knowledge-bases', { name: '  dental faqs ' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details).toEqual([{ path: 'name', message: 'You already have a knowledge base with this name' }]);
    // Another organization is free to use it.
    expect((await call(other, 'POST', '/v1/knowledge-bases', { name: 'Dental FAQs' })).statusCode).toBe(201);

    // Renaming to one's own name (a different case, say) is fine; to someone else's isn't.
    const second = (await call(org, 'POST', '/v1/knowledge-bases', { name: 'Pricing' })).json();
    expect((await call(org, 'PATCH', `/v1/knowledge-bases/${second.id}`, { name: 'PRICING' })).statusCode).toBe(200);
    expect((await call(org, 'PATCH', `/v1/knowledge-bases/${second.id}`, { name: 'dental faqs' })).statusCode).toBe(409);
  });
});

describe('a cancelled booking (BUG-09)', () => {
  const book = (org: Org, contactId: string, local: string) =>
    t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId, start: parseLocalStart(local, 'America/Toronto')!, title: 'Consult', createdBy: 'ai' });
  const stage = async (org: Org, contactId: string) => (await t.c.contacts.get(org.scope, contactId)).lifecycleStage;

  it('puts the contact back where they were, unless they have another booking', async () => {
    const org = await createOrg(t.c, 'Stage Co');
    const c = await t.c.contacts.create(org.scope, { firstName: 'Ana', lifecycleStage: 'engaged' });
    const a = await book(org, c.id, '2026-09-29T10:00');
    expect(await stage(org, c.id)).toBe('booked');
    const b = await book(org, c.id, '2026-09-30T10:00');

    await t.c.scheduling.cancel(org.scope, a.appointment.id, { actor: 'user' });
    expect(await stage(org, c.id)).toBe('booked'); // still has the 30th
    await t.c.scheduling.cancel(org.scope, b.appointment.id, { actor: 'user' });
    expect(await stage(org, c.id)).toBe('engaged');
    const events = await t.c.automation.listEvents(org.scope, { contactId: c.id });
    expect(events.find((e) => e.type === 'contact.updated' && (e.payload as { reason?: string }).reason === 'Booking cancelled')).toMatchObject({ payload: { lifecycleStage: 'engaged' } });
  });

  it('leaves a stage the team chose themselves', async () => {
    const org = await createOrg(t.c, 'Stage Team Co');
    const c = await t.c.contacts.create(org.scope, { firstName: 'Bo', lifecycleStage: 'booked' });
    const a = await book(org, c.id, '2026-09-29T11:00');
    await t.c.scheduling.cancel(org.scope, a.appointment.id, { actor: 'user' });
    expect(await stage(org, c.id)).toBe('booked');

    const d = await t.c.contacts.create(org.scope, { firstName: 'Cy' });
    const b = await book(org, d.id, '2026-09-29T12:00');
    await t.c.contacts.update(org.scope, d.id, { lifecycleStage: 'customer' });
    await t.c.scheduling.cancel(org.scope, b.appointment.id, { actor: 'user' });
    expect(await stage(org, d.id)).toBe('customer');
  });

  it('works for a booking the assistant cancelled in chat', async () => {
    const org = await createOrg(t.c, 'Stage AI Co');
    await t.c.bots.update(org.scope, org.bot.id, { config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] } } });
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Dee Ray' } }, { name: 'book_appointment', input: { start: '2026-09-29T10:00', customer_confirmed: true } }), text('Booked!')]);
    const r = await say(org, 'Dee Ray, Tuesday 10am');
    expect(await stage(org, r.contactId)).toBe('booked');
    const id = (lastToolResults(t.llm)[1]!.content as { appointment_id: string }).appointment_id;
    t.llm.setScript([tools({ name: 'cancel_appointment', input: { appointment_id: id, customer_confirmed: true } }), text('Cancelled.')]);
    await say(org, 'Please cancel it');
    expect(await stage(org, r.contactId)).not.toBe('booked');
  });
});

describe('one open deal per contact (BUG-11)', () => {
  const user = { source: 'user' as const };
  it('refuses a second open deal, names the first, and allows another once it is closed', async () => {
    const org = await createOrg(t.c, 'Deal Dup Co');
    const c = await t.c.contacts.create(org.scope, { firstName: 'Eve', email: 'eve@example.com' });
    const first = await t.c.deals.create(org.scope, { title: 'Invisalign', contactId: c.id }, user);

    const dup = await call(org, 'POST', '/v1/deals', { title: 'Duplicate deal test', contactId: c.id });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details).toEqual([
      { path: 'contactId', message: 'This contact already has an open deal in this pipeline' },
      { path: 'openDealId', message: first.id },
    ]);

    await t.c.deals.update(org.scope, first.id, { status: 'won' }, user);
    const second = await t.c.deals.create(org.scope, { title: 'Whitening', contactId: c.id }, user);
    // Reopening the first would make two open ones.
    const reopen = await call(org, 'PATCH', `/v1/deals/${first.id}`, { status: 'open' });
    expect(reopen.statusCode).toBe(409);
    await t.c.deals.update(org.scope, second.id, { status: 'lost' }, user);
    expect((await call(org, 'PATCH', `/v1/deals/${first.id}`, { status: 'open' })).statusCode).toBe(200);
  });

  it('is per pipeline, and simultaneous requests make one', async () => {
    const org = await createOrg(t.c, 'Deal Pipelines Co');
    const c = await t.c.contacts.create(org.scope, { firstName: 'Flo', email: 'flo@example.com' });
    const [sales] = await t.c.deals.listPipelines(org.scope);
    const onboarding = await t.c.deals.createPipeline(org.scope, { name: 'Onboarding', stages: [{ name: 'Start' }] });
    await t.c.deals.create(org.scope, { title: 'Sale', contactId: c.id, pipelineId: sales!.id }, user);
    await expect(t.c.deals.create(org.scope, { title: 'Onboard', contactId: c.id, pipelineId: onboarding.id }, user)).resolves.toBeTruthy();

    const d = await t.c.contacts.create(org.scope, { firstName: 'Gus', email: 'gus@example.com' });
    const results = await Promise.allSettled([1, 2, 3].map((i) => t.c.deals.create(org.scope, { title: `Race ${i}`, contactId: d.id }, user)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('deals from Test chats (BUG-12)', () => {
  it('can be shown on the board, and the stage counts always match the cards', async () => {
    const org = await createOrg(t.c, 'Deal Tests Co');
    const real = await t.c.contacts.create(org.scope, { firstName: 'Real', email: 'real@example.com' });
    const test = await t.c.contacts.create(org.scope, { firstName: 'Tester', email: 'tester@example.com' });
    await t.c.tenantDb.run(org.orgId, (tx) => tx.update(schema.contacts).set({ isTest: true }).where(eq(schema.contacts.id, test.id)));
    const user = { source: 'user' as const };
    await t.c.deals.create(org.scope, { title: 'Real deal', contactId: real.id }, user);
    const hidden = await t.c.deals.create(org.scope, { title: 'Test deal', contactId: test.id }, user);
    await t.c.deals.update(org.scope, hidden.id, { status: 'won' }, user);
    const [pipeline] = await t.c.deals.listPipelines(org.scope);
    const first = pipeline!.stages[0]!.id;

    const board = async (extra: string) => {
      const cards = (await call(org, 'GET', `/v1/deals?pipelineId=${pipeline!.id}&stageId=${first}&status=open${extra}`)).json() as unknown[];
      const summary = ((await call(org, 'GET', `/v1/deals/summary?pipelineId=${pipeline!.id}&status=open${extra}`)).json() as Array<{ stageId: string; count: number }>).find((s) => s.stageId === first)!;
      return { cards: cards.length, count: summary.count };
    };
    expect(await board('')).toEqual({ cards: 1, count: 1 });
    // Closed deals are not in the open count; with tests included the open test deal appears in both.
    await t.c.deals.update(org.scope, hidden.id, { status: 'open' }, user);
    expect(await board('')).toEqual({ cards: 1, count: 1 });
    expect(await board('&includeTest=true')).toEqual({ cards: 2, count: 2 });
  });
});

describe('plain messages in forms (BUG-13)', () => {
  it('names the field and says what to do, for organization settings', async () => {
    const org = await createOrg(t.c, 'Settings Errors Co');
    const country = await call(org, 'PATCH', '/v1/org', { settings: { defaultCountry: 'XX' } });
    expect(country.statusCode).toBe(400);
    expect(country.json().error.details).toEqual([{ path: 'settings.defaultCountry', message: 'Use a two-letter country code such as US, CA or IN' }]);

    const budget = await call(org, 'PATCH', '/v1/org', { monthlyAiBudgetUsd: -5 });
    expect(budget.json().error.details).toEqual([{ path: 'monthlyAiBudgetUsd', message: "The budget can't be negative" }]);

    const tz = await call(org, 'PATCH', '/v1/org', { timezone: 'Mars/Olympus' });
    expect(tz.json().error.details).toEqual([{ path: 'timezone', message: 'Choose a timezone from the list' }]);
    expect(country.body + budget.body + tz.body).not.toMatch(/expected number|Too small/);
  });

  it('says what is wrong with a website for the chat widget', async () => {
    expect(originProblem('https://www.example.com/')).toBeNull();
    expect(originProblem('https://www.example.com/contact')).toContain('has a page in it');
    expect(originProblem('example.com')).toContain("isn't a website address");
    expect(originProblem('not a url')).toContain('https://www.example.com');
    const org = await createOrg(t.c, 'Origins Co');
    const res = await call(org, 'PATCH', `/v1/channels/${org.webchat.id}`, { config: { allowedOrigins: ['example.com'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe('config.allowedOrigins.0');
  });
});

describe('the time this browser thinks it is (BUG-08)', () => {
  it('follows the server when the browser clock is a minute behind', () => {
    resetClock();
    const real = Date.now();
    // A response stamped by a server 60 s ahead of this browser; the round trip took 200 ms.
    noteServerTime(real + 60_000, real - 200, real);
    expect(clockOffset()).toBeGreaterThan(59_000);
    expect(clockOffset()).toBeLessThan(61_000);
    // Something the server stamped just now reads "just now", not "in 1m".
    expect(timeAgo(new Date(real + 60_000))).toBe('just now');
    expect(serverNow() - real).toBeGreaterThan(59_000);
    resetClock();
    expect(timeAgo(new Date(real + 60_000))).toBe('in 1m');
  });

  it('trusts the response that took the least time, and ignores a missing time', () => {
    resetClock();
    const now = Date.now();
    noteServerTime(now + 5_000, now - 2_000, now); // slow: ±1 s of doubt
    noteServerTime(now + 1_000, now - 40, now); // fast
    expect(Math.abs(clockOffset() - 1_000)).toBeLessThan(100);
    noteServerTime(Number.NaN, now, now);
    expect(Math.abs(clockOffset() - 1_000)).toBeLessThan(100);
    resetClock();
    expect(clockOffset()).toBe(0);
  });

  it('is sent by the server on every response and readable from the dashboard', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } });
    expect(Number(res.headers['x-server-time'])).toBe(t.now.value.getTime());
    const preflightFree = await t.app.inject({ method: 'GET', url: '/v1/org', headers: { origin: 'http://localhost:5173' } });
    expect(String(preflightFree.headers['access-control-expose-headers'])).toContain('x-server-time');
  });
});

describe('defaults that follow the business (BUG-20)', () => {
  it('a new organization in India starts with India and rupees', async () => {
    const org = await createOrg(t.c, 'Delhi Dental', 'Asia/Calcutta');
    const view = (await call(org, 'GET', '/v1/org')).json();
    expect(view.settings).toMatchObject({ defaultCountry: 'IN', currency: 'INR' });
    expect(view.timezoneRegion).toEqual({ country: 'IN', currency: 'INR' });
    // An Indian number typed without +91 is read as Indian.
    const c = await t.c.contacts.create(org.scope, { firstName: 'Ravi', phone: '098765 43210' });
    expect(c.phone).toBe('+919876543210');
  });

  it('an organization in an unlisted zone keeps the general defaults, and the saved currency is shown back', async () => {
    const org = await createOrg(t.c, 'Mid Atlantic Co', 'Atlantic/Azores');
    const view = (await call(org, 'GET', '/v1/org')).json();
    expect(view.settings).toMatchObject({ defaultCountry: 'US', currency: 'USD' });
    expect(view.timezoneRegion).toBeNull();
    const saved = await call(org, 'PATCH', '/v1/org', { settings: { currency: 'EUR', defaultCountry: 'pt' } });
    expect(saved.json().settings).toMatchObject({ currency: 'EUR', defaultCountry: 'PT' });
  });

  it('the current names of timezones are accepted, and the dashboard stops offering the old ones', async () => {
    const org = await createOrg(t.c, 'Kolkata Co');
    const res = await call(org, 'PATCH', '/v1/org', { timezone: 'Asia/Kolkata' });
    expect(res.statusCode).toBe(200);
    expect(res.json().timezone).toBe('Asia/Kolkata');

    expect(currentTimezoneName('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(currentTimezoneName('Asia/Katmandu')).toBe('Asia/Kathmandu');
    expect(currentTimezoneName('America/Toronto')).toBe('America/Toronto');
    const choices = timezoneChoices(Intl.supportedValuesOf('timeZone'));
    expect(choices).toContain('Asia/Kolkata');
    expect(choices).toContain('Asia/Kathmandu');
    expect(choices).not.toContain('Asia/Calcutta');
    expect(choices).not.toContain('Asia/Katmandu');
    for (const old of ['Africa/Asmera', 'America/Cordoba', 'America/Coral_Harbour', 'Europe/Kiev', 'Pacific/Truk']) expect(choices).not.toContain(old);
    expect(choices[0]).toBe('UTC');
    // Every choice is something the server accepts.
    for (const tz of choices) expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
  });

  it('knows real country codes and zones with one country', () => {
    expect(isCountryCode('IN')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(isCountryCode('us')).toBe(false);
    expect(regionOfTimezone('Asia/Kolkata')).toEqual({ country: 'IN', currency: 'INR' });
    expect(regionOfTimezone('Asia/Calcutta')).toEqual({ country: 'IN', currency: 'INR' });
    expect(regionOfTimezone('UTC')).toBeNull();
  });
});

describe('what a booking is called (BUG-18)', () => {
  it("is named after what the customer asked for, else the bot's default title", async () => {
    const org = await createOrg(t.c, 'Title Co');
    await t.c.bots.update(org.scope, org.bot.id, { config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'], appointmentTitle: 'Consultation' } } });
    t.llm.setScript([
      tools({ name: 'save_contact_details', input: { name: 'Pat Lee' } }, { name: 'book_appointment', input: { start: '2026-09-29T10:00', service: 'Check-up', customer_confirmed: true } }),
      text('Booked!'),
    ]);
    const r = await say(org, 'Pat Lee, a check-up on Tuesday at 10 please');
    expect(t.llm.requests[0]!.tools.find((x) => x.name === 'book_appointment')!.description).toContain('pass it as service');

    t.llm.setScript([tools({ name: 'book_appointment', input: { start: '2026-09-29T11:00', customer_confirmed: true } }), text('Booked!')]);
    await say(org, 'And Tuesday at 11, anything');
    const titles = (await t.c.scheduling.listForContact(org.scope, r.contactId)).map((a) => a.title).sort();
    expect(titles).toEqual(['Check-up with Pat Lee', 'Consultation with Pat Lee']);
  });
});

describe('a booking that waits for the team (BUG-19)', () => {
  it('is written with a readable date, and the same for requests saved earlier', async () => {
    expect(actionSummary('book_appointment', { start: '2026-10-08T09:30' })).toBe('Book an appointment on Thu 8 Oct 2026 at 9:30 AM');
    expect(actionSummary('reschedule_appointment', { new_start: '2026-10-09T15:00' })).toBe('Move an appointment to Fri 9 Oct 2026 at 3:00 PM');
    expect(actionSummary('book_appointment', { start: 'soon' })).toBe('Book an appointment on soon');

    const org = await createOrg(t.c, 'Approval Dates Co');
    await t.c.bots.update(org.scope, org.bot.id, {
      config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] }, actions: { ...org.bot.config.actions, askFirst: ['book_appointment'] } },
    });
    t.llm.setScript([
      tools({ name: 'save_contact_details', input: { name: 'Quinn' } }, { name: 'book_appointment', input: { start: '2026-09-29T09:30', customer_confirmed: true } }),
      text('I have asked the team to approve it; a team member will confirm.'),
    ]);
    await say(org, 'Quinn, Tuesday 9:30 please');
    expect(JSON.stringify(lastToolResults(t.llm)[1]!.content)).toMatch(/never say it is booked, scheduled, confirmed or done/);
    const list = (await call(org, 'GET', '/v1/approvals')).json() as Array<{ summary: string }>;
    expect(list[0]!.summary).toBe('Book an appointment on Tue 29 Sep 2026 at 9:30 AM');
    // An older request saved with the date in its raw form reads the same.
    await t.c.tenantDb.run(org.orgId, (tx) => tx.update(schema.actionApprovals).set({ summary: 'Book an appointment on 2026-09-29 at 09:30' }).where(eq(schema.actionApprovals.organizationId, org.orgId)));
    expect(((await call(org, 'GET', '/v1/approvals')).json() as Array<{ summary: string }>)[0]!.summary).toBe('Book an appointment on Tue 29 Sep 2026 at 9:30 AM');
  });

  it('a reply that calls it scheduled is sent back to be corrected once', async () => {
    const org = await createOrg(t.c, 'Approval Reply Co');
    await t.c.bots.update(org.scope, org.bot.id, {
      config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] }, actions: { ...org.bot.config.actions, askFirst: ['book_appointment'] } },
    });
    t.llm.setScript([
      tools({ name: 'save_contact_details', input: { name: 'Rae' } }, { name: 'book_appointment', input: { start: '2026-09-29T09:30', customer_confirmed: true } }),
      // QA's wording: it says scheduled, then that the team will confirm, in one sentence.
      text("I've scheduled your check-up for Tuesday at 9:30 AM, and a team member will confirm."),
      text("I've asked the team about Tuesday at 9:30 AM. A team member will confirm it, so nothing is booked yet."),
    ]);
    const r = await say(org, 'Rae, a check-up Tuesday 9:30 please');
    const reply = (await t.c.conversations.messages(org.scope, r.conversationId)).filter((m) => m.senderType === 'ai').at(-1)!.content;
    expect(reply).toBe("I've asked the team about Tuesday at 9:30 AM. A team member will confirm it, so nothing is booked yet.");
    const note = JSON.stringify(t.llm.requests.at(-1)!.messages);
    expect(note).toContain('only waiting for the team');
  });
});

describe('replies stay short and ask less (BUG-17)', () => {
  it("the short setting means one or two sentences, as the dashboard says, and details aren't asked for in a refusal or an answer to a sensitive question", async () => {
    const org = await createOrg(t.c, 'Short Co');
    await t.c.bots.update(org.scope, org.bot.id, { config: { persona: { ...org.bot.config.persona, responseLength: 'short' } } });
    t.llm.setScript([text('Hi!')]);
    await say(org, 'Hello');
    const system = t.llm.requests[0]!.system;
    expect(system).toContain('Keep replies short: one or two sentences.');
    expect(system).not.toContain('one to three sentences');
    expect(system).toContain('Never ask for details in a reply that declines something, answers a medical, legal or other sensitive question');
    expect(system).toContain('Ask for details at most once in a row');
    expect(system).toContain('ask only for what is missing (usually the country code)');
  });
});

// Keep the imports honest: these helpers are used above.
void and;
