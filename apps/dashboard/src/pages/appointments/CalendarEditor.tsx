import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useConfirm } from '../../components/feedback-context';
import { Button, Card, CardHeader, cx, ErrorBanner, Field, IconButton, Input, NumberInput, Select, SkeletonRows, Textarea, Toggle } from '../../components/ui';
import { ApiError, del, get, patch } from '../../lib/api';
import { addDays, formatDayHeading, formatLocalTime, isoDay } from '../../lib/format';
import { timezones } from '../../lib/hooks';
import { useAction } from '../../lib/mutations';
import { useOrg } from '../../lib/queries';
import { navigate } from '../../lib/router';
import { groupSlots } from '../../lib/slots';
import { WEEKDAYS, type Availability, type Calendar, type CalendarInput, type DateOverride, type TimeRange, type Weekday } from '../../lib/types';

export const DAY_LABEL: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

const REMINDER_CHOICES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Off' },
  { value: '1440', label: '1 day before' },
  { value: '1440,120', label: '1 day and 2 hours before' },
];

const NOTICE_CHOICES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any time before it starts' },
  { value: '120', label: 'Until 2 hours before' },
  { value: '720', label: 'Until 12 hours before' },
  { value: '1440', label: 'Until 24 hours before' },
  { value: '2880', label: 'Until 48 hours before' },
];

/** "1440,120" → "1 day, 2 hours before" for a value set through the API that the menu doesn't offer. */
function reminderLabel(minutes: number[]): string {
  const parts = minutes.map((m) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`));
  return `${parts.join(', ')} before`;
}

function toInput(c: Calendar): CalendarInput {
  return {
    name: c.name,
    description: c.description,
    timezone: c.timezone,
    slotMinutes: c.slotMinutes,
    slotIntervalMinutes: c.slotIntervalMinutes,
    bufferMinutes: c.bufferMinutes,
    minNoticeMinutes: c.minNoticeMinutes,
    maxDaysAhead: c.maxDaysAhead,
    maxPerDay: c.maxPerDay,
    weeklyHours: structuredClone(c.weeklyHours ?? {}),
    dateOverrides: structuredClone(c.dateOverrides ?? []),
    isActive: c.isActive,
    location: c.location ?? '',
    customerInstructions: c.customerInstructions ?? '',
    sendConfirmations: c.sendConfirmations ?? true,
    reminderMinutes: [...(c.reminderMinutes ?? [1440])],
    replyToEmail: c.replyToEmail ?? null,
    minCancelNoticeMinutes: c.minCancelNoticeMinutes ?? null,
  };
}

export function RangesEditor({ ranges, onChange, label }: { ranges: TimeRange[]; onChange: (r: TimeRange[]) => void; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ranges.map((r, i) => (
        <div key={i} className="flex items-center gap-1 rounded-md border border-border bg-surface-2/50 py-0.5 pr-0.5 pl-1.5">
          <input
            type="time"
            aria-label={`${label} range ${i + 1} start`}
            className="rounded bg-transparent px-1 py-0.5 text-body-sm tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            value={r.start}
            onChange={(e) => onChange(ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
          />
          <span className="text-caption text-muted">–</span>
          <input
            type="time"
            aria-label={`${label} range ${i + 1} end`}
            className="rounded bg-transparent px-1 py-0.5 text-body-sm tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            value={r.end}
            onChange={(e) => onChange(ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
          />
          <IconButton label={`Remove ${label} range ${i + 1}`} size="sm" className="size-6" onClick={() => onChange(ranges.filter((_, j) => j !== i))}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      ))}
      <Button
        size="xs"
        variant="ghost"
        icon={<Plus className="size-3" />}
        onClick={() => {
          const last = ranges[ranges.length - 1];
          onChange([...ranges, last ? { start: last.end, end: last.end < '17:00' ? '17:00' : '20:00' } : { start: '09:00', end: '17:00' }]);
        }}
      >
        {ranges.length ? 'Add hours' : 'Add opening hours'}
      </Button>
    </div>
  );
}

export function CalendarEditor({ calendar }: { calendar: Calendar }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState(() => toInput(calendar));
  const base = useMemo(() => toInput(calendar), [calendar]);
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const tzList = useMemo(() => timezones(), []);
  const org = useOrg();
  const suggestedReplyTo = org.data?.settings.notificationEmails?.[0];
  const set = <K extends keyof CalendarInput>(k: K, v: CalendarInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const reminderValue = form.reminderMinutes.join(',');
  const noticeValue = form.minCancelNoticeMinutes ? String(form.minCancelNoticeMinutes) : '';

  // PATCH sends the whole calendar: the server applies schema defaults to omitted fields.
  const save = useAction(() => patch<Calendar>(`/v1/calendars/${calendar.id}`, form), {
    errorToast: false,
    success: 'Calendar saved',
    onSuccess: (updated) => {
      qc.setQueryData<Calendar[]>(['calendars'], (list) => list?.map((c) => (c.id === updated.id ? updated : c)));
      void qc.invalidateQueries({ queryKey: ['calendars'] });
      void qc.invalidateQueries({ queryKey: ['availability', calendar.id] });
      setForm(toInput(updated));
    },
  });
  const remove = useAction(() => del(`/v1/calendars/${calendar.id}`), {
    invalidate: [['calendars'], ['bots']],
    success: 'Calendar deleted',
    onSuccess: () => navigate('/appointments/calendars', { replace: true }),
  });

  const setDay = (day: Weekday, ranges: TimeRange[]) => set('weeklyHours', { ...form.weeklyHours, [day]: ranges });
  const setOverride = (i: number, o: Partial<DateOverride>) => set('dateOverrides', form.dateOverrides.map((x, j) => (j === i ? { ...x, ...o } : x)));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={calendar.name}
          description={`${calendar.timezone} · ${calendar.slotMinutes}-minute slots`}
          actions={
            <>
              <Button
                size="sm"
                variant="danger-ghost"
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  if (await confirm({ title: `Delete “${calendar.name}”?`, message: 'Its appointments are deleted too, and bots using it stop booking.', confirmLabel: 'Delete calendar', danger: true })) remove.mutate();
                }}
              >
                Delete
              </Button>
              {dirty && (
                <Button size="sm" variant="ghost" onClick={() => setForm(base)}>
                  Discard
                </Button>
              )}
              <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
            </>
          }
        />
        <div className="space-y-6 p-4">
          {save.error ? <ErrorBanner error={save.error} title={save.error instanceof ApiError && save.error.details.length ? save.error.message : undefined} details={save.error instanceof ApiError ? save.error.details : undefined} /> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              <Input value={form.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Timezone" hint="Opening hours and slot times are in this timezone.">
              <Select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {!tzList.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
                {tzList.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description" className="col-span-2">
              <Textarea rows={2} maxLength={1000} value={form.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
          </div>
          <Toggle label="Accepting bookings" description="Turn off to pause all new bookings on this calendar." checked={form.isActive} onChange={(v) => set('isActive', v)} />

          <fieldset>
            <legend className="mb-3 text-body font-semibold text-fg">Slots</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Appointment length (min)">
                <NumberInput min={5} max={480} value={form.slotMinutes} onChange={(v) => set('slotMinutes', Math.round(v ?? 30))} />
              </Field>
              <Field label="Start a slot every (min)" hint="Empty = same as the length.">
                <NumberInput min={5} max={480} allowEmpty value={form.slotIntervalMinutes} onChange={(v) => set('slotIntervalMinutes', v === null ? null : Math.round(v))} />
              </Field>
              <Field label="Buffer between (min)">
                <NumberInput min={0} max={240} value={form.bufferMinutes} onChange={(v) => set('bufferMinutes', Math.round(v ?? 0))} />
              </Field>
              <Field label="Minimum notice (min)" hint="e.g. 120 = no bookings in the next 2 hours.">
                <NumberInput min={0} value={form.minNoticeMinutes} onChange={(v) => set('minNoticeMinutes', Math.round(v ?? 0))} />
              </Field>
              <Field label="Book up to (days ahead)">
                <NumberInput min={1} max={365} value={form.maxDaysAhead} onChange={(v) => set('maxDaysAhead', Math.round(v ?? 30))} />
              </Field>
              <Field label="Max per day" hint="Empty = no limit.">
                <NumberInput min={1} max={500} allowEmpty value={form.maxPerDay} onChange={(v) => set('maxPerDay', v === null ? null : Math.round(v))} />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1 text-body font-semibold text-fg">Emails to the customer</legend>
            <p className="mb-3 text-body-sm text-muted">
              Sent to the email saved on the contact: never to one waiting for duplicate review, and never from test chats. Each appointment shows what was sent.
            </p>
            <div className="space-y-4">
              <Toggle
                label="Confirmation"
                description="When a booking is made, with a calendar file, plus a notice if it moves or is cancelled."
                checked={form.sendConfirmations}
                onChange={(v) => set('sendConfirmations', v)}
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Reminders">
                  <Select value={reminderValue} onChange={(e) => set('reminderMinutes', e.target.value ? e.target.value.split(',').map(Number) : [])}>
                    {!REMINDER_CHOICES.some((c) => c.value === reminderValue) && <option value={reminderValue}>{reminderLabel(form.reminderMinutes)}</option>}
                    {REMINDER_CHOICES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reply-to email" hint="Where customers' replies go.">
                  <Input type="email" maxLength={254} value={form.replyToEmail ?? ''} placeholder="bookings@yourbusiness.com" onChange={(e) => set('replyToEmail', e.target.value.trim() || null)} />
                  {!form.replyToEmail && suggestedReplyTo && (
                    <Button size="xs" variant="ghost" className="mt-1 self-start" onClick={() => set('replyToEmail', suggestedReplyTo)}>
                      Use {suggestedReplyTo}
                    </Button>
                  )}
                </Field>
                <Field label="Location" hint="An address, or “Video call”. In the emails and the calendar file." className="col-span-2">
                  <Input value={form.location} maxLength={300} onChange={(e) => set('location', e.target.value)} />
                </Field>
                <Field label="Instructions for the customer" hint="Added to every email, e.g. “Please arrive 10 minutes early.”" className="col-span-2">
                  <Textarea rows={2} maxLength={2000} value={form.customerInstructions} onChange={(e) => set('customerInstructions', e.target.value)} />
                </Field>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-3 text-body font-semibold text-fg">Changes and cancellations</legend>
            <Field label="The assistant can move or cancel a booking" hint="Inside this window it offers your team instead. Your team can always change a booking.">
              <Select value={noticeValue} onChange={(e) => set('minCancelNoticeMinutes', e.target.value ? Number(e.target.value) : null)}>
                {!NOTICE_CHOICES.some((c) => c.value === noticeValue) && <option value={noticeValue}>Until {form.minCancelNoticeMinutes} minutes before</option>}
                {NOTICE_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>

          <fieldset>
            <legend className="mb-3 text-body font-semibold text-fg">Weekly hours</legend>
            <div className="divide-y divide-border rounded-lg border border-border">
              {WEEKDAYS.map((day) => {
                const ranges = form.weeklyHours[day] ?? [];
                return (
                  <div key={day} className="grid grid-cols-[120px_1fr] items-center gap-3 px-3 py-2">
                    <span className={cx('text-body-sm font-medium', ranges.length ? 'text-fg' : 'text-muted')}>
                      {DAY_LABEL[day]}
                      {!ranges.length && <span className="block text-caption font-normal">Closed</span>}
                    </span>
                    <RangesEditor label={DAY_LABEL[day]} ranges={ranges} onChange={(r) => setDay(day, r)} />
                  </div>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1 text-body font-semibold text-fg">Date overrides</legend>
            <p className="mb-3 text-body-sm text-muted">Holidays or special hours. A date with no hours is closed all day.</p>
            <div className="space-y-2">
              {form.dateOverrides.map((o, i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2">
                  <input
                    type="date"
                    aria-label={`Override ${i + 1} date`}
                    className="control w-40"
                    value={o.date}
                    onChange={(e) => setOverride(i, { date: e.target.value })}
                  />
                  <div className="flex-1 pt-1">
                    {!o.hours.length && <span className="mr-2 text-caption text-muted">Closed all day</span>}
                    <RangesEditor label={`Override ${o.date || i + 1}`} ranges={o.hours} onChange={(hours) => setOverride(i, { hours })} />
                  </div>
                  <IconButton label={`Remove override ${o.date}`} size="sm" onClick={() => set('dateOverrides', form.dateOverrides.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))}
              <Button
                size="sm"
                icon={<Plus className="size-3.5" />}
                onClick={() => set('dateOverrides', [...form.dateOverrides, { date: isoDay(addDays(new Date(), 7)), hours: [] }])}
              >
                Add date override
              </Button>
            </div>
          </fieldset>
        </div>
      </Card>
      <AvailabilityPreview calendar={calendar} dirty={dirty} />
    </div>
  );
}

function AvailabilityPreview({ calendar, dirty }: { calendar: Calendar; dirty: boolean }) {
  const from = isoDay(new Date());
  const to = isoDay(addDays(new Date(), 6));
  const availability = useQuery({
    queryKey: ['availability', calendar.id, from, to],
    queryFn: () => get<Availability>(`/v1/calendars/${calendar.id}/availability`, { from, to }),
  });
  const groups = groupSlots(availability.data?.slots ?? []);
  return (
    <Card>
      <CardHeader
        title="Availability preview"
        description={`Open slots for the next 7 days, as the assistant sees them${dirty ? ' (saved settings — save to update)' : ''}.`}
      />
      <div className="p-4">
        {availability.isLoading ? (
          <SkeletonRows rows={3} className="p-0" />
        ) : availability.error ? (
          <ErrorBanner error={availability.error} />
        ) : groups.length === 0 ? (
          <p className="text-body-sm text-muted">No open slots in the next 7 days. Check the weekly hours, minimum notice and whether the calendar is accepting bookings.</p>
        ) : (
          <div className="space-y-3">
            {groups.map(([day, slots]) => (
              <div key={day} className="grid grid-cols-1 gap-1 sm:grid-cols-[180px_1fr] sm:gap-3">
                <p className="text-body-sm font-medium text-fg-2">{formatDayHeading(day)}</p>
                <div className="flex flex-wrap gap-1">
                  {slots.map((s) => (
                    <span key={s.start} className="rounded bg-surface-2 px-1.5 py-0.5 text-caption text-fg-2 tabular-nums">
                      {formatLocalTime(s.local)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
