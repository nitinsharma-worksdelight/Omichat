import { describe, expect, it } from 'vitest';
import { checkSlot, computeSlots, parseLocalStart, type CalendarRules } from '../src/modules/scheduling/availability';

const rules: CalendarRules = {
  timezone: 'America/Toronto',
  slotMinutes: 30,
  slotIntervalMinutes: null,
  bufferMinutes: 0,
  minNoticeMinutes: 120,
  maxDaysAhead: 30,
  maxPerDay: null,
  weeklyHours: { mon: [{ start: '09:00', end: '12:00' }], tue: [{ start: '09:00', end: '10:00' }] },
  dateOverrides: [],
};
// Monday 2026-09-28 09:00 in Toronto (UTC-4)
const now = new Date('2026-09-28T13:00:00Z');

describe('availability engine', () => {
  it('generates slots in the calendar timezone and respects minimum notice', () => {
    const slots = computeSlots(rules, [], { from: '2026-09-28', to: '2026-09-28' }, now);
    // 09:00–12:00 minus 2h notice → first slot at 11:00
    expect(slots.map((s) => s.local)).toEqual(['2026-09-28T11:00', '2026-09-28T11:30']);
    expect(slots[0]!.start).toBe('2026-09-28T15:00:00.000Z');
  });

  it('skips busy intervals with buffers on both sides', () => {
    const busy = [{ start: new Date('2026-09-29T13:30:00Z'), end: new Date('2026-09-29T14:00:00Z') }]; // Tue 09:30–10:00
    const plain = computeSlots(rules, busy, { from: '2026-09-29', to: '2026-09-29' }, now);
    expect(plain.map((s) => s.local)).toEqual(['2026-09-29T09:00']);
    const buffered = computeSlots({ ...rules, bufferMinutes: 15 }, busy, { from: '2026-09-29', to: '2026-09-29' }, now);
    expect(buffered).toEqual([]);
  });

  it('applies date overrides (closed days and special hours)', () => {
    const closed = computeSlots({ ...rules, dateOverrides: [{ date: '2026-09-29', hours: [] }] }, [], { from: '2026-09-29', to: '2026-09-29' }, now);
    expect(closed).toEqual([]);
    const special = computeSlots(
      { ...rules, dateOverrides: [{ date: '2026-10-03', hours: [{ start: '10:00', end: '11:00' }] }] },
      [],
      { from: '2026-10-03', to: '2026-10-03' },
      now,
    );
    expect(special.map((s) => s.local)).toEqual(['2026-10-03T10:00', '2026-10-03T10:30']);
  });

  it('handles the DST change (Toronto falls back on 2026-11-01)', () => {
    const sunday = { ...rules, weeklyHours: { sun: [{ start: '09:00', end: '10:00' }] }, maxDaysAhead: 60 };
    const slots = computeSlots(sunday, [], { from: '2026-11-01', to: '2026-11-01' }, now);
    expect(slots[0]!.start).toBe('2026-11-01T14:00:00.000Z'); // UTC-5 after the change
  });

  it('respects maxPerDay and maxDaysAhead', () => {
    const perDay = new Map([['2026-09-29', 1]]);
    expect(computeSlots({ ...rules, maxPerDay: 1 }, [], { from: '2026-09-29', to: '2026-09-29' }, now, { bookedPerDay: perDay })).toEqual([]);
    expect(computeSlots({ ...rules, maxDaysAhead: 3 }, [], { from: '2026-10-05', to: '2026-10-06' }, now)).toEqual([]);
  });

  it('explains why a start time cannot be booked', () => {
    const tz = rules.timezone;
    expect(checkSlot(rules, [], parseLocalStart('2026-09-28T09:30', tz)!, now)).toMatch(/too soon/);
    expect(checkSlot(rules, [], parseLocalStart('2026-09-29T15:00', tz)!, now)).toMatch(/outside/);
    const busy = [{ start: new Date('2026-09-29T13:00:00Z'), end: new Date('2026-09-29T13:30:00Z') }];
    expect(checkSlot(rules, busy, parseLocalStart('2026-09-29T09:00', tz)!, now)).toMatch(/taken/);
    expect(checkSlot(rules, [], parseLocalStart('2026-09-29T09:30', tz)!, now)).toBeNull();
  });
});
