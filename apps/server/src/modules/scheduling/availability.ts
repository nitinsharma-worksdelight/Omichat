import { DateTime } from 'luxon';
import type { DateOverride, TimeRange, WeeklyHours, Weekday } from '../../db/schema';

export interface CalendarRules {
  timezone: string;
  slotMinutes: number;
  slotIntervalMinutes: number | null;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  maxPerDay: number | null;
  weeklyHours: WeeklyHours;
  dateOverrides: DateOverride[];
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot {
  start: string; // ISO UTC
  end: string;
  /** Calendar-local "YYYY-MM-DDTHH:mm" — the format booking tools accept. */
  local: string;
  label: string;
}

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateHours(ranges: TimeRange[]): string | null {
  for (const r of ranges) {
    if (!TIME_RE.test(r.start) || !(TIME_RE.test(r.end) || r.end === '24:00')) return `Invalid time range ${r.start}-${r.end}`;
    if (r.end <= r.start) return `Range ${r.start}-${r.end} ends before it starts`;
  }
  // Two ranges on the same day can't cover the same time: it would offer (and count) those times twice.
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return `Ranges ${sorted[i - 1]!.start}-${sorted[i - 1]!.end} and ${sorted[i]!.start}-${sorted[i]!.end} overlap`;
  }
  return null;
}

/** Ranges that overlap become one (older data may have them); touching ranges stay apart, as each starts its own slots. */
function mergeOverlapping(ranges: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.start.localeCompare(b.start))) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) last.end = r.end > last.end ? r.end : last.end;
    else out.push({ ...r });
  }
  return out;
}

/** Slot starts wanted within a day: from `from` (included) up to `to` (not included), "HH:mm". Either may be left out. */
export interface TimeWindow {
  from?: string;
  to?: string;
}

/** The windows behind the words a customer uses. */
export const DAY_PARTS: Record<'morning' | 'afternoon' | 'evening', TimeWindow> = {
  morning: { to: '12:00' },
  afternoon: { from: '12:00', to: '17:00' },
  evening: { from: '17:00' },
};

function hoursFor(rules: CalendarRules, date: DateTime): TimeRange[] {
  const iso = date.toISODate()!;
  const override = rules.dateOverrides.find((o) => o.date === iso);
  if (override) return override.hours;
  return rules.weeklyHours[WEEKDAYS[date.weekday - 1]!] ?? [];
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function formatSlotLabel(start: DateTime): string {
  return start.toFormat("ccc d LLL yyyy, h:mm a");
}

/**
 * Open slots between two calendar-local dates (inclusive). Pure: the caller supplies busy intervals
 * (booked appointments plus any external-calendar busy time) and the current time.
 */
const SHORT_DAY: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/**
 * A calendar's usual weekly hours in a line, consecutive days with the same hours grouped: "Mon–Fri 9:00–17:00,
 * Sat 10:00–14:00". Days missing here are never bookable (date overrides may still change single dates).
 */
export function weeklyHoursLabel(hours: WeeklyHours): string {
  const ranges = (d: Weekday) => (hours[d] ?? []).map((r) => `${r.start.replace(/^0(\d)/, '$1')}–${r.end.replace(/^0(\d)/, '$1')}`).join(', ');
  const groups: Array<{ from: Weekday; to: Weekday; label: string }> = [];
  for (const d of WEEKDAYS) {
    const label = ranges(d);
    if (!label) continue;
    const last = groups[groups.length - 1];
    if (last && last.label === label && WEEKDAYS.indexOf(last.to) === WEEKDAYS.indexOf(d) - 1) last.to = d;
    else groups.push({ from: d, to: d, label });
  }
  if (!groups.length) return 'no bookable days';
  return groups.map((g) => `${g.from === g.to ? SHORT_DAY[g.from] : `${SHORT_DAY[g.from]}–${SHORT_DAY[g.to]}`} ${g.label}`).join(', ');
}

export function computeSlots(
  rules: CalendarRules,
  busy: Interval[],
  range: { from: string; to: string },
  now: Date,
  opts: { limit?: number; bookedPerDay?: Map<string, number>; window?: TimeWindow } = {},
): Slot[] {
  const zone = rules.timezone;
  const nowLocal = DateTime.fromJSDate(now, { zone });
  const earliest = nowLocal.plus({ minutes: rules.minNoticeMinutes });
  const lastDay = nowLocal.startOf('day').plus({ days: rules.maxDaysAhead });
  let day = DateTime.fromISO(range.from, { zone }).startOf('day');
  const end = DateTime.min(DateTime.fromISO(range.to, { zone }).startOf('day'), lastDay);
  if (day < nowLocal.startOf('day')) day = nowLocal.startOf('day');
  const step = rules.slotIntervalMinutes ?? rules.slotMinutes;
  const padded = busy.map((b) => ({
    start: new Date(b.start.getTime() - rules.bufferMinutes * 60_000),
    end: new Date(b.end.getTime() + rules.bufferMinutes * 60_000),
  }));
  const slots: Slot[] = [];
  const seen = new Set<number>();
  const limit = opts.limit ?? 500;

  for (; day <= end && slots.length < limit; day = day.plus({ days: 1 })) {
    const iso = day.toISODate()!;
    if (rules.maxPerDay !== null && (opts.bookedPerDay?.get(iso) ?? 0) >= rules.maxPerDay) continue;
    for (const r of mergeOverlapping(hoursFor(rules, day))) {
      const windowStart = DateTime.fromISO(`${iso}T${r.start}`, { zone });
      const windowEnd = r.end === '24:00' ? day.plus({ days: 1 }) : DateTime.fromISO(`${iso}T${r.end}`, { zone });
      for (let s = windowStart; s.plus({ minutes: rules.slotMinutes }) <= windowEnd; s = s.plus({ minutes: step })) {
        if (s < earliest) continue;
        // The wanted part of the day is chosen here, before the limit counts anything: a limit must never cut off
        // the evening because the morning used it up.
        const clock = s.toFormat('HH:mm');
        if ((opts.window?.from && clock < opts.window.from) || (opts.window?.to && clock >= opts.window.to)) continue;
        const e = s.plus({ minutes: rules.slotMinutes });
        const interval = { start: s.toJSDate(), end: e.toJSDate() };
        if (padded.some((b) => overlaps(interval, b))) continue;
        // Never the same start twice (a window shared by two ranges, or a start repeated by a data oddity).
        if (seen.has(interval.start.getTime())) continue;
        seen.add(interval.start.getTime());
        slots.push({
          start: s.toUTC().toISO()!,
          end: e.toUTC().toISO()!,
          local: s.toFormat("yyyy-LL-dd'T'HH:mm"),
          label: formatSlotLabel(s),
        });
        if (slots.length >= limit) break;
      }
    }
  }
  return slots;
}

/** Calendar-local "YYYY-MM-DDTHH:mm" (or a full ISO string with offset) → Date. */
export function parseLocalStart(input: string, timezone: string): Date | null {
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(input);
  const dt = hasOffset ? DateTime.fromISO(input) : DateTime.fromISO(input, { zone: timezone });
  return dt.isValid ? dt.toJSDate() : null;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Why a specific start time can't be booked, or null when it can. */
export function checkSlot(rules: CalendarRules, busy: Interval[], start: Date, now: Date, bookedPerDay?: Map<string, number>): string | null {
  const local = DateTime.fromJSDate(start, { zone: rules.timezone });
  const iso = local.toISODate()!;
  if (local < DateTime.fromJSDate(now, { zone: rules.timezone }).plus({ minutes: rules.minNoticeMinutes })) {
    return `That time is too soon — bookings need at least ${formatDuration(rules.minNoticeMinutes)} notice.`;
  }
  const slots = computeSlots(rules, busy, { from: iso, to: iso }, now, { bookedPerDay });
  if (slots.some((s) => new Date(s.start).getTime() === start.getTime())) return null;
  const open = computeSlots(rules, [], { from: iso, to: iso }, now);
  if (!open.some((s) => new Date(s.start).getTime() === start.getTime())) {
    return 'That time is outside the available booking hours.';
  }
  return 'That time is already taken.';
}
