import { isEmail } from './validate';
import type { CalendarInput, TimeRange, Weekday } from './types';

/**
 * What is wrong with a calendar's settings, in plain words and next to the field it belongs to. The limits are the
 * server's, which checks again. No React or browser APIs here: the server's test suite tests these directly.
 */

const DAY_NAME: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const WEEKDAY_ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_NOTICE_MINUTES = 60 * 24 * 30;

export type CalendarField = 'name' | 'slotMinutes' | 'slotIntervalMinutes' | 'bufferMinutes' | 'minNoticeMinutes' | 'maxDaysAhead' | 'maxPerDay' | 'replyToEmail' | 'minCancelNoticeMinutes';

export interface CalendarProblems {
  fields: Partial<Record<CalendarField, string>>;
  /** Opening hours of a weekday. */
  days: Partial<Record<Weekday, string>>;
  /** Date overrides by their position in the list. */
  overrides: Record<number, string>;
  /** How many things need fixing. */
  count: number;
}

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** A whole number within limits, or the sentence that says what is allowed. */
function inRange(value: unknown, label: string, min: number, max: number, unit = ''): string | null {
  if (whole(value) && value >= min && value <= max) return null;
  if (whole(value) && value < min) return min === 0 ? `${label} can't be negative.` : `${label} must be at least ${min}${unit}.`;
  if (whole(value) && value > max) return `${label} can be at most ${max.toLocaleString('en-US')}${unit}.`;
  return `${label} must be a whole number between ${min} and ${max.toLocaleString('en-US')}${unit}.`;
}

/** The first problem with one day's opening hours (or a date override's), or null. */
export function hoursProblem(ranges: TimeRange[]): string | null {
  for (const r of ranges) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.start) || !(/^([01]\d|2[0-3]):[0-5]\d$/.test(r.end) || r.end === '24:00')) return 'Set both an opening and a closing time.';
    if (r.end <= r.start) return `Closing time (${r.end}) must be after opening time (${r.start}).`;
  }
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return `The hours ${sorted[i - 1]!.start}–${sorted[i - 1]!.end} and ${sorted[i]!.start}–${sorted[i]!.end} overlap.`;
  }
  return null;
}

export function calendarProblems(c: CalendarInput): CalendarProblems {
  const fields: CalendarProblems['fields'] = {};
  const put = (key: CalendarField, message: string | null) => {
    if (message) fields[key] = message;
  };
  put('name', c.name.trim() ? null : 'Name is required.');
  put('slotMinutes', inRange(c.slotMinutes, 'Appointment length', 5, 480, ' minutes'));
  if (c.slotIntervalMinutes !== null) put('slotIntervalMinutes', inRange(c.slotIntervalMinutes, 'Slot spacing', 5, 480, ' minutes'));
  put('bufferMinutes', inRange(c.bufferMinutes, 'Buffer', 0, 240, ' minutes'));
  put('minNoticeMinutes', inRange(c.minNoticeMinutes, 'Minimum notice', 0, MAX_NOTICE_MINUTES, ' minutes'));
  put('maxDaysAhead', inRange(c.maxDaysAhead, 'Booking window', 1, 365, ' days'));
  if (c.maxPerDay !== null) put('maxPerDay', inRange(c.maxPerDay, 'Max per day', 1, 500));
  if (c.minCancelNoticeMinutes !== null) put('minCancelNoticeMinutes', inRange(c.minCancelNoticeMinutes, 'Notice for changes', 0, MAX_NOTICE_MINUTES, ' minutes'));
  if (c.replyToEmail && !isEmail(c.replyToEmail)) put('replyToEmail', 'Enter a valid email address, like bookings@yourbusiness.com.');

  const days: CalendarProblems['days'] = {};
  for (const day of WEEKDAY_ORDER) {
    const problem = hoursProblem(c.weeklyHours[day] ?? []);
    if (problem) days[day] = `${DAY_NAME[day]}: ${problem}`;
  }
  const overrides: CalendarProblems['overrides'] = {};
  c.dateOverrides.forEach((o, i) => {
    const problem = !o.date ? 'Choose the date.' : hoursProblem(o.hours);
    if (problem) overrides[i] = problem;
  });
  return { fields, days, overrides, count: Object.keys(fields).length + Object.keys(days).length + Object.keys(overrides).length };
}

/** The calendar settings a save error can name, as the person sees them. */
const CALENDAR_LABEL: Record<string, string> = {
  name: 'Name',
  slotMinutes: 'Appointment length',
  slotIntervalMinutes: 'Slot spacing',
  bufferMinutes: 'Buffer',
  minNoticeMinutes: 'Minimum notice',
  maxDaysAhead: 'Booking window',
  maxPerDay: 'Max per day',
  replyToEmail: 'Reply-to email',
  minCancelNoticeMinutes: 'Notice for changes',
  dateOverrides: 'Date overrides',
};

/** A server error's field for a calendar, in words: "Appointment length", `Monday` for `weeklyHours.mon`. */
export function calendarFieldLabel(path: string): string {
  const [head, day] = path.split('.');
  if (head === 'weeklyHours' && day && day in DAY_NAME) return `${DAY_NAME[day as Weekday]} hours`;
  return CALENDAR_LABEL[head ?? ''] ?? '';
}
