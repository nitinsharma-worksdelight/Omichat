import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button, cx, EmptyState, ErrorBanner, SkeletonRows } from '../../components/ui';
import { get } from '../../lib/api';
import { addDays, formatDayHeading, formatLocalTime, isoDay } from '../../lib/format';
import { groupSlots } from '../../lib/slots';
import type { Availability, Slot } from '../../lib/types';

/** Open slots for one calendar, a week at a time. `value` is the slot's calendar-local start. */
export function SlotPicker({ calendarId, value, onChange, days = 7 }: { calendarId: string; value: string | null; onChange: (slot: Slot) => void; days?: number }) {
  const [from, setFrom] = useState(() => isoDay(new Date()));
  const to = isoDay(addDays(new Date(`${from}T12:00:00`), days - 1));
  const availability = useQuery({
    queryKey: ['availability', calendarId, from, to],
    queryFn: () => get<Availability>(`/v1/calendars/${calendarId}/availability`, { from, to }),
  });
  const today = isoDay(new Date());
  const shift = (n: number) => setFrom(isoDay(addDays(new Date(`${from}T12:00:00`), n)));
  const groups = groupSlots(availability.data?.slots ?? []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-fg-2">
          {formatDayHeading(from)} – {formatDayHeading(to)}
          {availability.data && <span className="ml-1 text-xs text-muted">({availability.data.calendar.timezone})</span>}
        </p>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" icon={<ChevronLeft className="size-3.5" />} disabled={from <= today} onClick={() => shift(-days)}>
            Earlier
          </Button>
          <Button size="xs" variant="ghost" onClick={() => shift(days)}>
            Later <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
      {availability.isLoading ? (
        <SkeletonRows rows={3} className="p-0" />
      ) : availability.error ? (
        <ErrorBanner error={availability.error} />
      ) : groups.length === 0 ? (
        <EmptyState title="No open slots in this range" description="Try later dates, or widen the calendar's opening hours." className="py-6" />
      ) : (
        <div className="max-h-72 space-y-3 overflow-y-auto pr-1" role="radiogroup" aria-label="Available times">
          {groups.map(([day, slots]) => (
            <div key={day}>
              <p className="mb-1.5 text-xs font-medium text-muted">{formatDayHeading(day)}</p>
              <div className="flex flex-wrap gap-1.5">
                {slots.map((s) => {
                  const selected = s.local === value;
                  return (
                    <button
                      key={s.start}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => onChange(s)}
                      className={cx(
                        'rounded-md border px-2.5 py-1 text-[13px] tabular-nums transition-colors',
                        selected ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong bg-surface text-fg hover:border-accent hover:text-accent-text',
                      )}
                    >
                      {formatLocalTime(s.local)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
