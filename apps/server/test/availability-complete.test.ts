import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeSlots, DAY_PARTS, parseLocalStart, validateHours, type CalendarRules } from '../src/modules/scheduling/availability';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * check_availability tells the truth about a calendar: every open time in what was asked for (no cap of its own, no
 * repeats), the part of the day chosen before any limit counts, and one exact time checked against the real rules.
 */

// Monday 2026-09-28 09:00 in Toronto (the test clock); "tomorrow" is Tuesday the 29th.
const now = new Date('2026-09-28T13:00:00Z');
const TOMORROW = '2026-09-29';
const everyDay = (start: string, end: string): CalendarRules['weeklyHours'] =>
  Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start, end }]]));
const rules = (over: Partial<CalendarRules> = {}): CalendarRules => ({
  timezone: 'America/Toronto',
  slotMinutes: 15,
  slotIntervalMinutes: null,
  bufferMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 60,
  maxPerDay: null,
  weeklyHours: everyDay('07:00', '21:00'),
  dateOverrides: [],
  ...over,
});
const times = (slots: Array<{ local: string }>) => slots.map((s) => s.local.slice(11));

describe('slots are never repeated', () => {
  it('when two ranges of a day overlap (older data), every time is listed once', () => {
    const r = rules({ slotMinutes: 30, weeklyHours: { tue: [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '20:00' }] } });
    const slots = times(computeSlots(r, [], { from: TOMORROW, to: TOMORROW }, now));
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots[0]).toBe('09:00');
    expect(slots.at(-1)).toBe('19:30');
    expect(slots).toHaveLength(22); // 09:00 … 19:30 every half hour
  });

  it('a calendar cannot be saved with overlapping hours, but touching ranges are fine', () => {
    expect(validateHours([{ start: '09:00', end: '13:00' }, { start: '12:00', end: '20:00' }])).toContain('overlap');
    expect(validateHours([{ start: '12:00', end: '20:00' }, { start: '09:00', end: '13:00' }])).toContain('overlap');
    expect(validateHours([{ start: '09:00', end: '12:00' }, { start: '12:00', end: '17:00' }])).toBeNull();
    expect(validateHours([{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }])).toBeNull();
  });
});

describe('the part of the day is chosen before the limit', () => {
  const week = { from: TOMORROW, to: '2026-10-05' };
  it('a limit used up by the mornings cannot hide the evenings', () => {
    const plain = computeSlots(rules(), [], week, now, { limit: 300 });
    const plainEvening = plain.filter((s) => s.local.slice(11, 13) >= '17');
    // The old order: the first 300 slots, then "evening" — short of the 7 × 16 evening slots there are.
    expect(plainEvening.length).toBeLessThan(7 * 16);

    const evening = computeSlots(rules(), [], week, now, { limit: 300, window: DAY_PARTS.evening });
    expect(evening).toHaveLength(7 * 16); // 17:00 … 20:45 on each of the 7 days
    expect(new Set(evening.map((s) => s.local.slice(0, 10))).size).toBe(7);
    expect(evening.every((s) => s.local.slice(11) >= '17:00')).toBe(true);
  });

  it('morning, afternoon and a custom range include their start and leave out their end', () => {
    const day = { from: TOMORROW, to: TOMORROW };
    const at = (window: Parameters<typeof computeSlots>[4]) => times(computeSlots(rules(), [], day, now, window));
    const morning = at({ window: DAY_PARTS.morning });
    expect(morning[0]).toBe('07:00');
    expect(morning.at(-1)).toBe('11:45');
    const afternoon = at({ window: DAY_PARTS.afternoon });
    expect([afternoon[0], afternoon.at(-1)]).toEqual(['12:00', '16:45']);
    const custom = at({ window: { from: '16:00', to: '19:00' } });
    expect([custom[0], custom.at(-1), custom.length]).toEqual(['16:00', '18:45', 12]);
    expect(at({ window: { from: '20:00' } })).toEqual(['20:00', '20:15', '20:30', '20:45']);
  });
});

describe('check_availability for the assistant', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  type Org = Awaited<ReturnType<typeof createOrg>>;
  async function setup(name: string, hours = { start: '09:00', end: '21:00' }) {
    const org = await createOrg(t.c, name);
    await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, { slotMinutes: 30, minNoticeMinutes: 0, weeklyHours: everyDay(hours.start, hours.end) as never });
    await t.c.bots.update(org.scope, org.bot.id, { config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] } } });
    return org;
  }
  async function ask(org: Org, input: Record<string, unknown>, reply = 'ok', visitor = 'v') {
    t.llm.setScript([tools({ name: 'check_availability', input }), text(reply)]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content: 'Is it free?' });
    await t.c.queue.drain();
    return { data: lastToolResults(t.llm)[0]!.content as Record<string, any>, r };
  }

  it('"all slots for tomorrow" lists every open time, once each, not five or six', async () => {
    const org = await setup('All Slots Co');
    const { data } = await ask(org, { date_from: TOMORROW, date_to: TOMORROW });
    const listed = data.days[0].times.map((x: { start: string }) => x.start.slice(11));
    expect(data.days).toHaveLength(1);
    expect(listed).toHaveLength(24); // 09:00 … 20:30 every half hour
    expect(new Set(listed).size).toBe(24);
    expect(data.total_times).toBe(24);
    expect(data.truncated).toBeUndefined();
    expect(data.note).toContain('complete for the range searched');
  });

  it('every day of a week is listed, not just the first five', async () => {
    const org = await setup('Week Co');
    const { data } = await ask(org, { date_from: TOMORROW, date_to: '2026-10-05' });
    expect(data.days.map((d: { date: string }) => d.date)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    expect(data.days.every((d: { times: unknown[] }) => d.times.length === 24)).toBe(true);
  });

  it('evening means the evening of every day asked for, from 17:00', async () => {
    const org = await setup('Evening Co');
    const { data } = await ask(org, { date_from: TOMORROW, date_to: '2026-10-01', time_of_day: 'evening' });
    expect(data.days).toHaveLength(3);
    for (const day of data.days) {
      const starts = day.times.map((x: { start: string }) => x.start.slice(11));
      expect(starts).toEqual(['17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30']);
    }
    const range = (await ask(org, { date_from: TOMORROW, date_to: TOMORROW, from_time: '16:00', to_time: '19:00' }, 'ok', 'w')).data;
    expect(range.days[0].times.map((x: { start: string }) => x.start.slice(11))).toEqual(['16:00', '16:30', '17:00', '17:30', '18:00', '18:30']);
  });

  it('a very long list is cut at a stated point, and says so', async () => {
    const org = await createOrg(t.c, 'Long Co');
    await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, { slotMinutes: 5, minNoticeMinutes: 0, weeklyHours: everyDay('07:00', '21:00') as never });
    await t.c.bots.update(org.scope, org.bot.id, { config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] } } });
    const { data } = await ask(org, { date_from: TOMORROW, date_to: '2026-10-05' });
    expect(data.truncated).toBe(true);
    expect(data.total_times).toBe(300);
    // 168 five-minute slots a day: the 300th is on the second day.
    expect(data.listed_through).toBe('2026-09-30T17:55');
    expect(data.note).toContain('only the first part of a long list');
    expect(data.days.flatMap((d: { times: unknown[] }) => d.times)).toHaveLength(300);
  });

  describe('one exact time', () => {
    it('is true for a free slot, and the assistant can say so without being corrected', async () => {
      const org = await setup('Exact Co');
      const { data } = await ask(org, { date_from: TOMORROW, time: '18:00' }, 'Yes, 6:00 PM is available tomorrow. Shall I book it?');
      expect(data).toMatchObject({ available: true, time_checked: '18:00', days: [{ date: TOMORROW, times: [{ start: `${TOMORROW}T18:00` }] }] });
      // Said it with one model call after the tool: the reply check had nothing to correct.
      expect(t.llm.requests).toHaveLength(2);
    });

    it('is false for a booked slot, with the reason and the nearest open times', async () => {
      const org = await setup('Taken Co');
      const person = await t.c.contacts.create(org.scope, { firstName: 'Pat', email: `pat${Math.random()}@example.com` });
      await t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId: person.id, start: parseLocalStart(`${TOMORROW}T18:00`, 'America/Toronto')!, title: 'x', createdBy: 'user' });
      const { data } = await ask(org, { date_from: TOMORROW, time: '18:00' }, 'Sorry, 6:00 PM is taken. 5:30 PM or 6:30 PM?');
      expect(data).toMatchObject({ available: false, reason: 'That time is already taken.' });
      expect(data.next_available.map((x: { start: string }) => x.start.slice(11))).toEqual(['17:00', '17:30', '18:30']); // the three nearest, in time order
      expect(t.llm.requests).toHaveLength(2);
    });

    it('says why a time outside the hours, off the grid, or too soon is not available', async () => {
      const org = await setup('Reasons Co');
      const check = (time: string, date = TOMORROW) => t.c.scheduling.checkTime(org.scope, org.calendar.id, `${date}T${time}`);
      expect(await check('22:00')).toMatchObject({ available: false, reason: 'That time is outside the available booking hours.' });
      expect(await check('18:10')).toMatchObject({ available: false, reason: 'That time is outside the available booking hours.' });
      await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, { minNoticeMinutes: 120 });
      expect(await check('10:00', '2026-09-28')).toMatchObject({ available: false, reason: expect.stringContaining('too soon') });
      expect(await check('18:00')).toMatchObject({ available: true, reason: null, slot: { local: `${TOMORROW}T18:00` } });
    });

    it('agrees with what booking itself accepts', async () => {
      const org = await setup('Agree Co');
      const person = await t.c.contacts.create(org.scope, { firstName: 'Lee', email: `lee${Math.random()}@example.com` });
      for (const time of ['09:00', '12:30', '18:00', '20:30', '21:00', '08:30', '18:10']) {
        const start = parseLocalStart(`${TOMORROW}T${time}`, 'America/Toronto')!;
        const said = (await t.c.scheduling.checkTime(org.scope, org.calendar.id, `${TOMORROW}T${time}`)).available;
        const booked = await t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId: person.id, start, title: 'x', createdBy: 'user' }).then(
          () => true,
          () => false,
        );
        expect(said, time).toBe(booked);
      }
    });

    it('checks each day when a range is given, and lists only the days that are open', async () => {
      const org = await setup('Days Co');
      const person = await t.c.contacts.create(org.scope, { firstName: 'Sam', email: `sam${Math.random()}@example.com` });
      await t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId: person.id, start: parseLocalStart(`${TOMORROW}T18:00`, 'America/Toronto')!, title: 'x', createdBy: 'user' });
      const { data } = await ask(org, { date_from: TOMORROW, date_to: '2026-09-30', time: '18:00' });
      expect(data.available).toBe(true);
      expect(data.days).toEqual([{ date: '2026-09-30', times: [expect.objectContaining({ start: '2026-09-30T18:00' })] }]);
      expect(data.not_available_on).toEqual([{ date: TOMORROW, reason: 'That time is already taken.' }]);
    });
  });

  it('the dashboard slot list is not cut at 200', async () => {
    const org = await createOrg(t.c, 'Picker Co');
    await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, { slotMinutes: 15, minNoticeMinutes: 0, weeklyHours: everyDay('07:00', '21:00') as never });
    const res = await t.app.inject({ method: 'GET', url: `/v1/calendars/${org.calendar.id}/availability?from=${TOMORROW}&to=2026-10-05`, headers: authHeaders(org.token, org.orgId) });
    const slots = res.json().slots as Array<{ local: string }>;
    expect(slots).toHaveLength(7 * 56);
    expect(new Set(slots.map((s) => s.local)).size).toBe(slots.length);
  });

  it('calendar hours with overlapping ranges are refused when saved', async () => {
    const org = await createOrg(t.c, 'Overlap Save Co');
    const overlapping = [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '20:00' }];
    const week = await t.app.inject({ method: 'PATCH', url: `/v1/calendars/${org.calendar.id}`, headers: authHeaders(org.token, org.orgId), payload: { weeklyHours: { tue: overlapping } } });
    expect(week.statusCode).toBe(400);
    expect(week.body).toContain('overlap');
    const special = await t.app.inject({ method: 'PATCH', url: `/v1/calendars/${org.calendar.id}`, headers: authHeaders(org.token, org.orgId), payload: { dateOverrides: [{ date: '2026-10-12', hours: overlapping }] } });
    expect(special.statusCode).toBe(400);
  });
});
