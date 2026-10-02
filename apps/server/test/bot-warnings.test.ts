import { describe, expect, it } from 'vitest';
import type { BotConfig, Calendar, WeeklyHours } from '../../dashboard/src/lib/types';
import { bookingAbilities, botWarnings, hoursSummary, openDaysIn, starterProblem } from '../../dashboard/src/pages/bots/warnings';
import { BotConfigSchema } from '../src/modules/bots/config';

/**
 * Q4 — what the bot editor and the Bots page flag in a bot's settings. The checks live in the dashboard without React
 * or browser APIs, so they're tested here, on settings with the server's own defaults.
 */

const CAL = '00000000-0000-4000-8000-000000000001';
const WEEKDAYS_9_5: WeeklyHours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [{ start: '09:00', end: '17:00' }]]));
const calendar = (weeklyHours: WeeklyHours = WEEKDAYS_9_5) => ({ id: CAL, name: 'Main calendar', timezone: 'America/Toronto', weeklyHours }) as unknown as Calendar;

/** A bot's settings: the server's defaults (booking off, lead capture on), with changes. */
function config(change: (c: BotConfig) => void = () => {}): BotConfig {
  const c = BotConfigSchema.parse({}) as unknown as BotConfig;
  change(c);
  return c;
}
const booking = (c: BotConfig) => Object.assign(c.booking, { enabled: true, calendarId: CAL });
const starter = (label: string, message = '') => ({ id: label, label, message, action: 'message' as const, enabled: true, order: 0 });
const ids = (c: BotConfig, calendars: Calendar[] = [calendar()]) => botWarnings(c, calendars).map((w) => w.id);

describe('booking starters and goals (BUG-01)', () => {
  it('flags starters that offer what the bot can’t do', () => {
    const off = bookingAbilities(config());
    expect(starterProblem(starter('Book an appointment'), off)).toContain('Booking is off');
    expect(starterProblem(starter('Reschedule my appointment'), off)).toContain('Booking is off');
    expect(starterProblem(starter('Opening hours?'), off)).toBeNull();

    const noCancel = bookingAbilities(config((c) => Object.assign(booking(c), { allowCancel: false })));
    expect(starterProblem(starter('Cancel my appointment'), noCancel)).toContain('Cancelling is off');
    expect(starterProblem(starter('Book an appointment'), noCancel)).toBeNull();
    expect(starterProblem(starter('Change my booking', 'I need to move my appointment'), bookingAbilities(config((c) => Object.assign(booking(c), { allowReschedule: false }))))).toContain(
      'Rescheduling is off',
    );
    // A switched-off booking tool counts as off.
    expect(bookingAbilities(config((c) => (booking(c), (c.actions.disabledTools = ['book_appointment'])))).book).toBe(false);
  });

  it('lists them once, and only enabled ones', () => {
    expect(ids(config((c) => (c.conversationStarters = [starter('Book an appointment'), { ...starter('Cancel'), enabled: false }])))).toContain('starters-booking');
    expect(ids(config((c) => (c.conversationStarters = [{ ...starter('Book an appointment'), enabled: false }])))).not.toContain('starters-booking');
    expect(ids(config((c) => (booking(c), (c.conversationStarters = [starter('Book an appointment')]))))).not.toContain('starters-booking');
  });

  it('flags goals about booking while booking is off', () => {
    expect(ids(config((c) => (c.goals.primary = 'Help visitors book an appointment')))).toContain('goals-booking');
    expect(ids(config((c) => (booking(c), (c.goals.primary = 'Help visitors book an appointment'))))).not.toContain('goals-booking');
    expect(ids(config((c) => (c.goals.primary = 'Answer questions about prices')))).not.toContain('goals-booking');
  });
});

describe('opening hours vs the calendar (BUG-03)', () => {
  it('reads the days an opening-hours text says are open', () => {
    const days = (text: string) => [...openDaysIn(text)].sort();
    expect(days('Mon-Fri 9-6, Sat 10-2, closed Sun')).toEqual(['fri', 'mon', 'sat', 'thu', 'tue', 'wed']);
    expect(days('Monday to Friday 9am–5pm')).toEqual(['fri', 'mon', 'thu', 'tue', 'wed']);
    expect(days('Mon–Fri 9am–5pm, Sat 10am–2pm by appointment')).toContain('sat');
    expect(days('Weekends 10–4')).toEqual(['sat', 'sun']);
    expect(days('Open daily 8–8')).toHaveLength(7);
    expect(days('Fri–Mon')).toEqual(['fri', 'mon', 'sat', 'sun']);
    expect(days('Tues & Thurs evenings')).toEqual(['thu', 'tue']);
    expect(days('By appointment only, all month')).toEqual([]); // nothing it can read: no warning
  });

  it('warns about a day the calendar has no hours for, only when the bot books', () => {
    const qa = config((c) => (booking(c), (c.business.hours = 'Mon-Fri 9-6, Sat 10-2, closed Sun')));
    const w = botWarnings(qa, [calendar()]).find((x) => x.id === 'hours-calendar');
    expect(w?.message).toBe(
      "Opening hours mention Saturday, but Main calendar has no Saturday hours: visitors may hear you're open but can't book. Check your FAQ too.",
    );
    expect(ids(config((c) => (booking(c), (c.business.hours = 'Mon–Fri 9am–5pm'))))).not.toContain('hours-calendar');
    expect(ids(config((c) => (c.business.hours = 'Mon-Fri 9-6, Sat 10-2')))).not.toContain('hours-calendar'); // booking off
    expect(ids(qa, [calendar({ ...WEEKDAYS_9_5, sat: [{ start: '10:00', end: '14:00' }] })])).not.toContain('hours-calendar');
  });

  it('sums up the calendar’s hours', () => {
    expect(hoursSummary({ ...WEEKDAYS_9_5, sat: [{ start: '10:00', end: '14:00' }] })).toBe('Mon–Fri 9:00–17:00, Sat 10:00–14:00');
    expect(hoursSummary({ mon: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }], wed: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }] })).toBe(
      'Mon 9:00–12:00, 13:00–17:00, Wed 9:00–12:00, 13:00–17:00',
    );
    expect(hoursSummary({})).toBe('no open hours');
  });
});

describe('lead capture vs booking details (BUG-06)', () => {
  it('flags a detail booking needs that lead capture doesn’t ask for', () => {
    const c = config((x) => (booking(x), (x.booking.requiredFields = ['name', 'phone']), (x.leadCapture.fields = x.leadCapture.fields.filter((f) => f.field !== 'phone'))));
    expect(ids(c)).toContain('booking-needs-phone');
    expect(ids(c)).not.toContain('booking-needs-name');
  });

  it('flags a detail that holds up bookings though booking doesn’t need it', () => {
    const c = config((x) => {
      booking(x);
      x.leadCapture.fields = x.leadCapture.fields.map((f) => (f.field === 'phone' ? { ...f, required: true, timing: 'before_booking' } : f));
    });
    const w = botWarnings(c, [calendar()]).find((x) => x.id === 'holds-up-phone');
    expect(w).toMatchObject({ section: 'booking', also: 'leadCapture' });
    expect(ids(config((x) => (booking(x), (x.booking.requiredFields = ['name', 'email', 'phone']))))).not.toContain('holds-up-phone');
  });
});

describe('privacy notice (BUG-07)', () => {
  it('is asked for while lead capture collects details', () => {
    expect(ids(config())).toContain('privacy-notice');
    expect(ids(config((c) => (c.leadCapture.consentNotice = '   ')))).toContain('privacy-notice');
    expect(ids(config((c) => (c.leadCapture.consentNotice = 'We use your details only to reply to you.')))).not.toContain('privacy-notice');
    expect(ids(config((c) => (c.leadCapture.enabled = false)))).not.toContain('privacy-notice');
  });

  it('is trimmed when saved, so spaces alone count as none', () => {
    expect(BotConfigSchema.parse({ leadCapture: { consentNotice: '  ' } }).leadCapture.consentNotice).toBe('');
  });
});

it('a bot with nothing to flag has no warnings', () => {
  const c = config((x) => {
    booking(x);
    x.leadCapture.consentNotice = 'We use your details only to reply to you.';
    x.business.hours = 'Mon–Fri 9–5';
    x.conversationStarters = [starter('Book an appointment')];
  });
  expect(botWarnings(c, [calendar()])).toEqual([]);
});
