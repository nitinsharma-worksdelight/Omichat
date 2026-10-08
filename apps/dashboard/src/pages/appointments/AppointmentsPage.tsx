import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, Check, Mail, Plus, Search, UserX, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Drawer, Modal } from '../../components/overlay';
import { AppointmentStatusBadge } from '../../components/status';
import { Badge, Button, Card, Checkbox, cx, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, SkeletonRows, Spinner, Tabs, Textarea } from '../../components/ui';
import { get, post } from '../../lib/api';
import { formatDateTime, formatDayHeading, formatLocalTime, isoDay } from '../../lib/format';
import { timezones, useDebounced } from '../../lib/hooks';
import { currentTimezoneName } from '../../lib/timezones';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useCalendars } from '../../lib/queries';
import { Link, navigate } from '../../lib/router';
import type { Appointment, AppointmentEmail, AppointmentStatus, Calendar, Contact, ContactList, CustomerEmailOutcome, Slot } from '../../lib/types';
import { CalendarEditor } from './CalendarEditor';
import { SlotPicker } from './SlotPicker';

/** Why an email to the customer wasn't sent (or was dropped), in words. */
const EMAIL_REASON: Record<string, string> = {
  not_requested: 'your team chose not to email them',
  emails_off: 'emails are off for this calendar',
  test_contact: 'test conversation',
  no_email: 'no email on file',
  email_under_review: 'their email is waiting for duplicate review',
  never_confirmed: 'they never had a confirmation',
  send_failed: 'the last email failed',
  appointment_moved: 'the appointment moved',
  appointment_cancelled: 'the appointment was cancelled',
  appointment_ended: 'the appointment was completed or marked no-show',
  appointment_changed: 'the appointment changed',
  too_late: 'the appointment had already started',
  reminders_off: 'reminders were turned off',
};

/** " · confirmation emailed to x" for the toast after booking, moving or cancelling. */
function emailNote(what: string, outcome: CustomerEmailOutcome | undefined): string {
  if (!outcome || outcome.reason === 'unchanged') return '';
  if (outcome.queued) return ` · ${what} emailed to ${outcome.to}`;
  return outcome.reason ? ` · no email: ${EMAIL_REASON[outcome.reason] ?? outcome.reason}` : '';
}

export function AppointmentsPage({ view, calendarId }: { view: 'agenda' | 'calendars'; calendarId: string | null }) {
  const { role } = useAuth();
  const [booking, setBooking] = useState(false);
  const [creatingCalendar, setCreatingCalendar] = useState(false);
  return (
    <div>
      <PageHeader
        title="Appointments"
        description="Bookings made by your assistants and your team, and the calendars they book into."
        actions={
          view === 'agenda'
            ? roleAtLeast(role, 'agent') && (
                <Button variant="primary" icon={<CalendarPlus className="size-4" />} onClick={() => setBooking(true)}>
                  Book appointment
                </Button>
              )
            : roleAtLeast(role, 'admin') && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreatingCalendar(true)}>
                  New calendar
                </Button>
              )
        }
      >
        <Tabs
          className="px-6"
          ariaLabel="Appointments views"
          value={view}
          onChange={(v) => navigate(v === 'agenda' ? '/appointments' : '/appointments/calendars')}
          tabs={[
            { id: 'agenda', label: 'Agenda' },
            { id: 'calendars', label: 'Calendars' },
          ]}
        />
      </PageHeader>
      <div className="px-4 py-6 sm:px-8">{view === 'agenda' ? <Agenda /> : <Calendars calendarId={calendarId} />}</div>
      {booking && <BookDialog onClose={() => setBooking(false)} />}
      {creatingCalendar && <NewCalendarDialog onClose={() => setCreatingCalendar(false)} />}
    </div>
  );
}

// ---------- Agenda ----------

function Agenda() {
  const calendars = useCalendars();
  const { role } = useAuth();
  const canAct = roleAtLeast(role, 'agent');
  const [calendarId, setCalendarId] = useState('');
  const [status, setStatus] = useState<AppointmentStatus | ''>('booked');
  // Start of today (local), so today's earlier appointments can still be marked completed / no-show.
  const [from] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  });
  const appts = useQuery({
    queryKey: ['appointments', { from, calendarId, status }],
    queryFn: () => get<Appointment[]>('/v1/appointments', { from, calendarId, status }),
  });
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [emailsOf, setEmailsOf] = useState<Appointment | null>(null);
  const setApptStatus = useAction(({ id, status: s }: { id: string; status: 'completed' | 'no_show' }) => post(`/v1/appointments/${id}/status`, { status: s }), {
    invalidate: [['appointments'], ['contact-appointments']],
    success: (_d, v) => (v.status === 'completed' ? 'Marked as completed' : 'Marked as no-show'),
  });

  const calendarName = (id: string) => calendars.data?.find((c) => c.id === id)?.name ?? 'Calendar';
  const groups = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const a of appts.data ?? []) {
      const day = a.localStart.slice(0, 10);
      map.set(day, [...(map.get(day) ?? []), a]);
    }
    return [...map.entries()];
  }, [appts.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select aria-label="Calendar" className="w-56" value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
          <option value="">All calendars</option>
          {(calendars.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value as AppointmentStatus | '')}>
          <option value="">All statuses</option>
          <option value="booked">Booked</option>
          <option value="completed">Completed</option>
          <option value="no_show">No-show</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <span className="text-body-sm text-muted">From today onwards</span>
      </div>
      {appts.isLoading ? (
        <Card>
          <SkeletonRows rows={5} />
        </Card>
      ) : appts.error ? (
        <ErrorBanner error={appts.error} onRetry={() => void appts.refetch()} />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-5" />}
            title="No upcoming appointments"
            description="Turn on booking in a bot's Booking tab so the assistant can book for visitors — or book one yourself."
          />
        </Card>
      ) : (
        groups.map(([day, list]) => (
          <section key={day} aria-label={formatDayHeading(day)}>
            <h2 className="mb-2.5 text-label font-semibold tracking-[0.06em] text-muted uppercase">
              {day === isoDay(new Date()) ? 'Today · ' : ''}
              {formatDayHeading(day)}
            </h2>
            <Card className="divide-y divide-border">
              {list.map((a) => (
                // One line only on wide screens; narrower, the buttons drop below the appointment instead of squeezing it.
                <div key={a.id} className={cx('flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 xl:flex-nowrap', a.status === 'cancelled' && 'opacity-60')}>
                  <div className="w-20 shrink-0 border-r border-border pr-3">
                    <p className="font-display text-heading font-semibold text-fg tabular-nums">{formatLocalTime(a.localStart)}</p>
                    <p className="truncate text-label text-muted" title={a.timezone}>
                      {a.timezone.split('/').pop()?.replace(/_/g, ' ')}
                    </p>
                  </div>
                  {/* At least 12rem: with less room the buttons go to the next line rather than squeeze it. */}
                  <div className="min-w-48 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm font-medium text-fg">
                      <span className="min-w-0 break-words">{a.title}</span>
                      <AppointmentStatusBadge status={a.status} />
                      <Badge tone={a.createdBy === 'ai' ? 'ai' : a.createdBy === 'user' ? 'human' : 'slate'}>{a.createdBy === 'ai' ? 'Booked by AI' : a.createdBy === 'user' ? 'Booked by team' : 'Booked by contact'}</Badge>
                    </p>
                    <p className="truncate text-caption text-muted">
                      <Link to={`/contacts/${a.contactId}`} className="text-accent-text hover:underline">
                        {a.contact?.name || a.contact?.email || a.contact?.phone || 'Contact'}
                      </Link>
                      {a.contact?.email && ` · ${a.contact.email}`}
                      {a.contact?.phone && ` · ${a.contact.phone}`} · {calendarName(a.calendarId)}
                    </p>
                    {a.notes && <p className="mt-0.5 truncate text-caption text-fg-2">{a.notes}</p>}
                    {a.cancelReason && <p className="mt-0.5 text-caption text-danger-text">Cancelled: {a.cancelReason}</p>}
                  </div>
                  {/* Never wider than the row: on a narrow screen the buttons wrap inside it instead of running off. */}
                  <div className="flex max-w-full flex-wrap items-center gap-1">
                    <Button size="xs" variant="ghost" icon={<Mail className="size-3" />} onClick={() => setEmailsOf(a)} aria-label={`Emails to the customer about ${a.title}`}>
                      Emails
                    </Button>
                    {canAct && a.status === 'booked' && (
                      <div className="flex flex-wrap items-center gap-1">
                        <Button size="xs" onClick={() => setRescheduling(a)}>
                          Reschedule
                        </Button>
                        <Button size="xs" variant="ghost" icon={<Check className="size-3" />} onClick={() => setApptStatus.mutate({ id: a.id, status: 'completed' })}>
                          Completed
                        </Button>
                        <Button size="xs" variant="ghost" icon={<UserX className="size-3" />} onClick={() => setApptStatus.mutate({ id: a.id, status: 'no_show' })}>
                          No-show
                        </Button>
                        <Button size="xs" variant="danger-ghost" icon={<X className="size-3" />} onClick={() => setCancelling(a)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </Card>
          </section>
        ))
      )}
      {rescheduling && <RescheduleDialog appointment={rescheduling} onClose={() => setRescheduling(null)} />}
      {cancelling && <CancelDialog appointment={cancelling} onClose={() => setCancelling(null)} />}
      <EmailsDrawer appointment={emailsOf} canAct={canAct} onClose={() => setEmailsOf(null)} />
    </div>
  );
}

function RescheduleDialog({ appointment, onClose }: { appointment: Appointment; onClose: () => void }) {
  const [slot, setSlot] = useState<Slot | null>(null);
  const [notify, setNotify] = useState(true);
  const reschedule = useAction(() => post<Appointment>(`/v1/appointments/${appointment.id}/reschedule`, { start: slot!.local, notifyCustomer: notify }), {
    invalidate: [['appointments'], ['availability'], ['contact-appointments'], ['appointment-emails', appointment.id]],
    success: (a) => `Appointment rescheduled${emailNote('the change', a.customerEmail)}`,
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title="Reschedule appointment"
      description={`${appointment.title} with ${appointment.contact?.name || appointment.contact?.email || 'contact'} — currently ${appointment.label} (${appointment.timezone})`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!slot} loading={reschedule.isPending} onClick={() => reschedule.mutate()}>
            {slot ? `Move to ${slot.label}` : 'Pick a new time'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SlotPicker calendarId={appointment.calendarId} value={slot?.local ?? null} onChange={setSlot} />
        <Checkbox label="Email the customer about the change" description="Only if they had a confirmation." checked={notify} onChange={(e) => setNotify(e.target.checked)} />
      </div>
    </Modal>
  );
}

function CancelDialog({ appointment, onClose }: { appointment: Appointment; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const cancel = useAction(
    () => post<Appointment>(`/v1/appointments/${appointment.id}/cancel`, { ...(reason.trim() ? { reason: reason.trim() } : {}), notifyCustomer: notify }),
    {
      invalidate: [['appointments'], ['availability'], ['contact-appointments'], ['appointment-emails', appointment.id]],
      success: (a) => `Appointment cancelled${emailNote('a cancellation notice', a.customerEmail)}`,
      onSuccess: onClose,
    },
  );
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title="Cancel appointment?"
      description={`${appointment.title} · ${appointment.label}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel appointment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Reason" hint="Optional. Saved on the appointment and sent with the webhook. Not included in the email.">
          <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Checkbox label="Email the customer a cancellation notice" description="Only if they had a confirmation." checked={notify} onChange={(e) => setNotify(e.target.checked)} />
      </div>
    </Modal>
  );
}

const EMAIL_KIND: Record<AppointmentEmail['kind'], string> = {
  confirmation: 'Confirmation',
  update: 'Change notice',
  cancellation: 'Cancellation notice',
  reminder: 'Reminder',
};

function emailStatus(e: AppointmentEmail): { tone: 'green' | 'amber' | 'red' | 'slate'; label: string } {
  switch (e.status) {
    case 'sent':
      return { tone: 'green', label: 'Sent' };
    case 'pending':
      return { tone: 'amber', label: e.attempts ? 'Retrying' : 'Scheduled' };
    case 'sending':
      return { tone: 'amber', label: 'Sending' };
    case 'failed':
      return { tone: 'red', label: 'Failed' };
    case 'skipped':
      return { tone: 'slate', label: 'Not sent' };
    default:
      return { tone: 'slate', label: 'Dropped' };
  }
}

function reminderWhen(minutes: number | null): string {
  if (!minutes) return '';
  return minutes % 1440 === 0 ? ` · ${minutes / 1440} day${minutes === 1440 ? '' : 's'} before` : ` · ${minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`} before`;
}

function EmailsDrawer({ appointment, canAct, onClose }: { appointment: Appointment | null; canAct: boolean; onClose: () => void }) {
  const emails = useQuery({
    queryKey: ['appointment-emails', appointment?.id],
    queryFn: () => get<AppointmentEmail[]>(`/v1/appointments/${appointment!.id}/notifications`),
    enabled: Boolean(appointment),
    // An email that is due now goes out within seconds: follow it until it has.
    refetchInterval: (query) =>
      query.state.data?.some((e) => e.status === 'sending' || (e.status === 'pending' && new Date(e.sendAt).getTime() <= Date.now() + 5_000)) ? 2_000 : false,
  });
  const resend = useAction(() => post<CustomerEmailOutcome>(`/v1/appointments/${appointment!.id}/resend-confirmation`), {
    invalidate: [['appointment-emails', appointment?.id]],
    success: (o) => (o.queued ? `Confirmation on its way to ${o.to}` : `Not sent: ${EMAIL_REASON[o.reason ?? ''] ?? o.reason}`),
  });
  return (
    <Drawer
      open={Boolean(appointment)}
      onClose={onClose}
      title="Emails to the customer"
      description={appointment ? `${appointment.title} · ${appointment.label} (${appointment.timezone})` : undefined}
      footer={
        canAct && appointment?.status === 'booked' ? (
          <Button icon={<Mail className="size-3.5" />} loading={resend.isPending} onClick={() => resend.mutate()}>
            Resend confirmation
          </Button>
        ) : undefined
      }
    >
      {emails.isLoading ? (
        <SkeletonRows rows={3} className="p-0" />
      ) : emails.error ? (
        <ErrorBanner error={emails.error} />
      ) : !emails.data?.length ? (
        <EmptyState title="No emails" description="This booking was made before customer emails existed, or emails are off for its calendar." />
      ) : (
        <ol className="space-y-2">
          {emails.data.map((e) => {
            const status = emailStatus(e);
            return (
              <li key={e.id} className="rounded-xl border border-border p-3.5 text-body-sm">
                <p className="flex items-center justify-between gap-2">
                  <span className="font-medium text-fg">
                    {EMAIL_KIND[e.kind]}
                    <span className="font-normal text-muted">{e.kind === 'reminder' ? reminderWhen(e.reminderMinutes) : ''}</span>
                  </span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </p>
                <p className="mt-1 text-caption text-muted">
                  {e.status === 'sent' && e.sentAt
                    ? `${formatDateTime(e.sentAt)} to ${e.recipient}`
                    : e.status === 'pending' || e.status === 'sending'
                      ? `${formatDateTime(e.sendAt)}${e.recipient ? ` to ${e.recipient}` : ''}`
                      : e.reason
                        ? EMAIL_REASON[e.reason] ?? e.reason
                        : ''}
                </p>
                {e.error && <p className="mt-1 text-caption text-danger-text">{e.error}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </Drawer>
  );
}

function BookDialog({ onClose }: { onClose: () => void }) {
  const calendars = useCalendars();
  const active = (calendars.data ?? []).filter((c) => c.isActive);
  const [calendarId, setCalendarId] = useState('');
  useEffect(() => {
    if (!calendarId && active[0]) setCalendarId(active[0].id);
  }, [active, calendarId]);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim(), 250);
  const [contact, setContact] = useState<Contact | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [title, setTitle] = useState('Appointment');
  const [notes, setNotes] = useState('');
  const [notify, setNotify] = useState(true);
  const results = useQuery({
    queryKey: ['contacts', { search: debounced, picker: true }],
    queryFn: () => get<ContactList>('/v1/contacts', { search: debounced, limit: 8 }),
    enabled: debounced.length >= 2 && !contact,
  });
  const book = useAction(
    () =>
      post<Appointment>('/v1/appointments', {
        calendarId,
        contactId: contact!.id,
        start: slot!.local,
        title: title.trim() || 'Appointment',
        notes: notes.trim() || undefined,
        notifyCustomer: notify,
      }),
    {
      invalidate: [['appointments'], ['availability'], ['contact-appointments']],
      success: (a) => `Appointment booked${emailNote('a confirmation', a.customerEmail)}`,
      onSuccess: onClose,
      errorToast: false,
    },
  );

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title="Book an appointment"
      description="Staff bookings follow the same availability rules as the assistant."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!calendarId || !contact || !slot} loading={book.isPending} onClick={() => book.mutate()}>
            {slot ? `Book ${slot.label}` : 'Book'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {calendars.isLoading ? (
          <Spinner />
        ) : active.length === 0 ? (
          <EmptyState title="No active calendars" description="Create a calendar first, under Appointments → Calendars." />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Calendar">
                <Select
                  value={calendarId}
                  onChange={(e) => {
                    setCalendarId(e.target.value);
                    setSlot(null);
                  }}
                >
                  {active.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({currentTimezoneName(c.timezone)})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Title">
                <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
              </Field>
            </div>
            <div>
              {contact ? (
                <Field label="Contact">
                  <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                    <span className="text-body-sm text-fg">
                      <span className="font-medium">{contact.name || 'Unnamed'}</span>
                      <span className="text-muted"> · {[contact.email, contact.phone].filter(Boolean).join(' · ') || 'no contact details'}</span>
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => setContact(null)}>
                      Change
                    </Button>
                  </div>
                </Field>
              ) : (
                <Field label="Contact" hint="Search by name, email or phone (at least 2 characters).">
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
                    <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a contact" />
                  </div>
                </Field>
              )}
              {!contact && debounced.length >= 2 && (
                <div className="mt-2 rounded-lg border border-border">
                  {results.isLoading ? (
                    <div className="p-3">
                      <Spinner />
                    </div>
                  ) : !results.data?.items.length ? (
                    <p className="p-3 text-body-sm text-muted">No contacts match “{debounced}”.</p>
                  ) : (
                    <ul role="listbox" aria-label="Matching contacts" className="max-h-48 overflow-y-auto">
                      {results.data.items.map((c) => (
                        <li key={c.id}>
                          <button type="button" role="option" aria-selected={false} className="w-full px-3 py-2 text-left text-body-sm hover:bg-surface-2" onClick={() => setContact(c)}>
                            <span className="font-medium text-fg">{c.name || 'Unnamed'}</span>
                            <span className="text-muted"> · {[c.email, c.phone].filter(Boolean).join(' · ') || 'no details'}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            {calendarId && (
              <div>
                <p className="mb-2 text-body-sm font-medium text-fg-2">Time</p>
                <SlotPicker key={calendarId} calendarId={calendarId} value={slot?.local ?? null} onChange={setSlot} />
              </div>
            )}
            <Field label="Notes" hint="For your team; not included in the customer's emails.">
              <Textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <Checkbox
              label="Email the customer"
              description="A confirmation now and reminders before it, as set on the calendar."
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
            />
            {book.error ? <ErrorBanner error={book.error} /> : null}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- Calendars ----------

function Calendars({ calendarId }: { calendarId: string | null }) {
  const calendars = useCalendars();
  const { role } = useAuth();
  useEffect(() => {
    const first = calendars.data?.[0];
    if (first && (!calendarId || !calendars.data?.some((c) => c.id === calendarId))) navigate(`/appointments/calendars/${first.id}`, { replace: true });
  }, [calendarId, calendars.data]);
  const selected = calendars.data?.find((c) => c.id === calendarId) ?? null;

  if (calendars.isLoading) return <SkeletonRows rows={4} />;
  if (calendars.error) return <ErrorBanner error={calendars.error} />;
  if (!calendars.data?.length) {
    return (
      <Card>
        <EmptyState icon={<CalendarDays className="size-5" />} title="No calendars" description="Create a calendar with your opening hours so the assistant can offer appointment slots." />
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
      <nav aria-label="Calendars" className="space-y-1">
        {calendars.data.map((c) => (
          <Link
            key={c.id}
            to={`/appointments/calendars/${c.id}`}
            aria-current={c.id === calendarId ? 'page' : undefined}
            className={cx('block rounded-lg px-3 py-2 text-body-sm transition-colors', c.id === calendarId ? 'bg-accent-soft text-accent-text' : 'text-fg-2 hover:bg-surface-2 hover:text-fg')}
          >
            <span className="flex items-center justify-between gap-2 font-medium">
              <span className="truncate">{c.name}</span>
              {!c.isActive && <Badge tone="slate">paused</Badge>}
            </span>
            <span className="block truncate text-caption text-muted">{currentTimezoneName(c.timezone)}</span>
          </Link>
        ))}
      </nav>
      <div className="min-w-0">
        {selected ? (
          roleAtLeast(role, 'admin') ? (
            <CalendarEditor key={`${selected.id}`} calendar={selected} />
          ) : (
            <Card className="p-4 text-body-sm text-muted">Only admins can edit calendars.</Card>
          )
        ) : null}
      </div>
    </div>
  );
}

function NewCalendarDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(() => currentTimezoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
  const tzList = useMemo(() => timezones(), []);
  const create = useAction(
    () =>
      post<Calendar>('/v1/calendars', {
        name: name.trim(),
        timezone,
        weeklyHours: {
          mon: [{ start: '09:00', end: '17:00' }],
          tue: [{ start: '09:00', end: '17:00' }],
          wed: [{ start: '09:00', end: '17:00' }],
          thu: [{ start: '09:00', end: '17:00' }],
          fri: [{ start: '09:00', end: '17:00' }],
        },
      }),
    {
      invalidate: [['calendars']],
      success: 'Calendar created',
      onSuccess: (c) => {
        onClose();
        navigate(`/appointments/calendars/${c.id}`);
      },
    },
  );
  return (
    <Modal
      open
      onClose={onClose}
      title="New calendar"
      description="Starts with Monday–Friday, 9am–5pm. You can change everything next."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-calendar" loading={create.isPending} disabled={!name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <form
        id="new-calendar"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Name" required>
          <Input value={name} maxLength={120} placeholder="Consultations" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Timezone">
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {tzList.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Modal>
  );
}
