import { DateTime } from 'luxon';
import type { OrgSettings } from '../../db/schema';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Whether the team is around at `now`. No schedule (or one that's switched off) means always. */
export function isTeamOpen(settings: OrgSettings, timezone: string, now: Date): boolean {
  const hours = settings.teamHours;
  if (!hours?.enabled) return true;
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) return true;
  const minutes = local.hour * 60 + local.minute;
  const ranges = hours.weekly[WEEKDAYS[local.weekday - 1]!] ?? [];
  return ranges.some((r) => minutes >= toMinutes(r.start) && minutes < toMinutes(r.end));
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
