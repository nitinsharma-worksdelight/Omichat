import { CalendarDays, Check, Info, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from '../../../components/overlay';
import { Badge, Button, Checkbox, cx, EmptyState, Field, IconButton, Input, Select, Toggle } from '../../../components/ui';
import { Link } from '../../../lib/router';
import type { Actions, Booking, BookingRequiredField, LeadCapture, Qualification, Workflow } from '../../../lib/types';
import { ActionsSection, LeadCaptureSection, QualificationSection, type EditorContext } from '../../bots/sections';
import { currentTimezoneName } from '../../../lib/timezones';

function Footer({ onRemove, onCancel, children }: { onRemove: (() => void) | null; onCancel: (() => void) | null; children: ReactNode }) {
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button variant="danger-ghost" icon={<Trash2 className="size-4" aria-hidden />} disabled={!onRemove} onClick={() => onRemove?.()}>
        Remove
      </Button>
      <span className="flex-1" />
      {onCancel && (
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      )}
      {children}
    </div>
  );
}

/** A copy of `value` while the modal is open, so Cancel throws its edits away. */
function useLocal<T>(open: boolean, value: T): [T, (v: T) => void] {
  const [local, setLocal] = useState<T>(value);
  useEffect(() => {
    if (open) setLocal(structuredClone(value));
    // Only when it opens: the draft changing underneath doesn't reset what's being edited.
  }, [open]);
  return [local, setLocal];
}

const BOOKING_FIELDS: BookingRequiredField[] = ['name', 'email', 'phone'];
const DEFAULT_APPOINTMENT_TITLE = 'Consultation';
const BOOKING_ASK = ['book_appointment', 'reschedule_appointment', 'cancel_appointment'] as const;

/** An Advanced Options checkbox (GHL's style): label, what it does, and what it needs once it's checked. */
function BookingOption({ label, description, checked, onChange, children }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <Checkbox label={label} description={description} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {checked && children && <div className="ml-[26px] max-w-lg">{children}</div>}
    </div>
  );
}

/** A switch on the left of its label, with an ⓘ for more. */
function BookingSwitch({ label, tip, description, checked, onChange, disabled }: { label: string; tip?: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = `booking-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <div className="flex items-start gap-3">
      <Toggle id={id} checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5" />
      <div className="min-w-0">
        <label htmlFor={id} className="flex items-center gap-1.5 text-body-sm font-semibold text-fg">
          {label}
          {tip && (
            <span title={tip} className="text-muted">
              <Info className="size-3.5" aria-label={tip} />
            </span>
          )}
        </label>
        <p className="text-body-sm text-fg-2">{description}</p>
      </div>
    </div>
  );
}

/** What a booking passes to its workflows; one that needs any other chat input can't run after a booking. */
const BOOKING_WORKFLOW_INPUTS = ['appointment_id', 'appointment_time', 'appointment_timezone'];
const unmetInputs = (w: Workflow) => w.inputFields.filter((f) => f.required && (f.source ?? 'chat') === 'chat' && !BOOKING_WORKFLOW_INPUTS.includes(f.name)).map((f) => f.name);

const isUrl = (v: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

/** GHL's Appointment Booking: 1 Calendar Selection, 2 Advanced Options. Save turns booking on with them. */
export function BookingModal({
  open,
  booking,
  askFirst,
  qualificationOn,
  contactInfoAsks,
  ctx,
  onApply,
  onClose,
}: {
  open: boolean;
  booking: Booking;
  askFirst: Actions['askFirst'];
  qualificationOn: boolean;
  /** What the Contact Info action asks for ("Asks for name and email."), when it has required details; else null. */
  contactInfoAsks: string | null;
  ctx: EditorContext;
  onApply: (booking: Booking, askFirst: Actions['askFirst']) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [value, setValue] = useLocal(open, booking);
  const asking = BOOKING_ASK.some((t) => askFirst.includes(t));
  const [ask, setAsk] = useState(asking);
  const [note, setNote] = useState(true);
  const [tried, setTried] = useState(false);
  const calendars = ctx.calendars;
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setAsk(asking);
    setNote(true);
    setTried(false);
    // With one calendar, it's the choice.
    if (!booking.calendarId && calendars.length === 1) setValue({ ...structuredClone(booking), calendarId: calendars[0]!.id });
  }, [open]);
  const set = <K extends keyof Booking>(key: K, v: Booking[K]) => setValue({ ...value, [key]: v });
  const calendar = calendars.find((c) => c.id === value.calendarId);
  const workflows = ctx.workflows;
  const members = ctx.members;
  // What a checked option still needs (the server refuses the same).
  const problems = {
    link: value.linkOnly && !isUrl(value.bookingLink.trim()) ? 'Enter the full booking link, starting with https://' : undefined,
    workflows: value.triggerWorkflows && value.workflowKeys.length === 0 ? 'Choose at least one workflow.' : undefined,
    transfer: value.transferEmployee && !value.transferUserId ? 'Choose who gets the conversation.' : undefined,
  };
  const shown: Partial<typeof problems> = tried ? problems : {};
  const save = () => {
    setTried(true);
    if (Object.values(problems).some(Boolean)) return;
    const rest = askFirst.filter((t) => !(BOOKING_ASK as readonly string[]).includes(t));
    // An empty title would leave the booking unnamed: it takes the default.
    onApply({ ...value, appointmentTitle: value.appointmentTitle.trim() || DEFAULT_APPOINTMENT_TITLE, bookingLink: value.bookingLink.trim(), enabled: true }, ask ? [...rest, ...BOOKING_ASK] : rest);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-text">
            <CalendarDays className="size-5" aria-hidden />
          </span>
          <span>
            Appointment Booking
            <span className="block text-body-sm font-normal text-fg-2">Define the logic for booking an appointment</span>
          </span>
        </span>
      }
      footer={
        <Footer
          onRemove={booking.enabled ? () => onApply({ ...booking, enabled: false }, askFirst.filter((t) => !(BOOKING_ASK as readonly string[]).includes(t))) : null}
          onCancel={step === 1 ? onClose : null}
        >
          {step === 2 && (
            <Button variant="secondary" onClick={() => setStep(1)}>
              Previous
            </Button>
          )}
          <Button variant="primary" disabled={!value.calendarId} onClick={() => (step === 1 ? setStep(2) : save())}>
            {step === 1 ? 'Proceed' : 'Save'}
          </Button>
        </Footer>
      }
    >
      <ol aria-label="Steps" className="mb-6 grid grid-cols-[auto_1fr] items-start gap-x-3 sm:grid-cols-[1fr_1fr]">
        {(
          [
            [1, 'Calendar Selection', 'Choose calendar(s) for booking appointments'],
            [2, 'Advanced Options', 'Configure additional booking behaviors'],
          ] as const
        ).map(([n, title, text]) => (
          <li key={n} className={cx('flex flex-col gap-1.5', n === 2 && 'col-span-2 mt-3 sm:col-span-1 sm:mt-0')} aria-current={step === n ? 'step' : undefined}>
            <span className="flex items-center gap-2.5">
              <span
                className={cx(
                  'flex size-8 shrink-0 items-center justify-center rounded-full text-body',
                  step === n ? 'bg-accent text-accent-fg' : step > n ? 'border border-accent text-accent-text' : 'border border-border-strong text-faint',
                )}
              >
                {step > n ? <Check className="size-4" aria-label="Done" /> : n}
              </span>
              <span className={cx('whitespace-nowrap text-[16px]', step === n ? 'font-medium text-fg' : 'text-faint')}>{title}</span>
              {n === 1 && <span aria-hidden className="mx-2 hidden h-px flex-1 bg-border-strong sm:block" />}
            </span>
            <span className={cx('pl-[42px] text-body-sm', step === n ? 'text-fg-2' : 'text-faint')}>{text}</span>
          </li>
        ))}
      </ol>
      {step === 1 ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div aria-current="true" className="rounded-lg border-2 border-accent bg-accent-soft p-4">
              <p className="font-semibold text-accent-text">Single calendar</p>
              <p className="text-body-sm text-fg-2">Use a single calendar for all appointment bookings.</p>
            </div>
            <div aria-disabled="true" className="rounded-lg border border-border p-4 opacity-60">
              <p className="flex items-center gap-2 font-semibold text-fg-2">
                Multi calendars <Badge tone="slate">Coming soon</Badge>
              </p>
              <p className="text-body-sm text-muted">Let the AI pick from multiple calendars when booking appointments.</p>
            </div>
          </div>
          {calendars.length === 0 ? (
            <EmptyState
              title="No calendars yet"
              description="Create a calendar with your opening hours first; the agent books into it."
              action={
                <Link to="/appointments/calendars" className="font-medium text-accent-text hover:underline">
                  Create a calendar →
                </Link>
              }
            />
          ) : (
            <Field
              label="Pick a calendar"
              hint={
                <>
                  This calendar will be used for getting available slots and booking an appointment.{' '}
                  <Link to="/appointments/calendars" className="text-accent-text hover:underline">
                    Manage calendars
                  </Link>
                </>
              }
            >
              <Select value={value.calendarId ?? ''} onChange={(e) => set('calendarId', e.target.value || null)}>
                <option value="">Select calendar</option>
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({currentTimezoneName(c.timezone)}){c.isActive ? '' : ' — inactive'}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {calendar && !calendar.isActive && <p className="text-body-sm text-warning-text">This calendar is inactive, so it has no open times until you turn it on.</p>}
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          <div className="space-y-5 p-4">
            <BookingOption
              label="Don't book appointment (only send the booking link)"
              description="Selecting this will stop the bot from booking the appointment and directly send the booking link to the contact"
              checked={value.linkOnly}
              onChange={(v) => set('linkOnly', v)}
            >
              <Field label="Booking link" required error={shown.link} hint="The page where customers pick a time and book.">
                <Input type="url" inputMode="url" placeholder="https://" maxLength={500} value={value.bookingLink} onChange={(e) => set('bookingLink', e.target.value)} />
              </Field>
            </BookingOption>
            <BookingOption
              label="Pause bot responses after booking"
              description="Disable further bot responses after an appointment is successfully booked"
              checked={value.pauseAfterBooking}
              onChange={(v) => set('pauseAfterBooking', v)}
            >
              <p className="text-caption text-muted">The bot confirms the booking, then stays quiet until your team presses Resume AI in Conversations.</p>
            </BookingOption>
            <BookingOption
              label="Trigger workflow after booking"
              description="Execute specified workflows on successful appointment booking"
              checked={value.triggerWorkflows}
              onChange={(v) => set('triggerWorkflows', v)}
            >
              {workflows === null ? (
                <p className="text-caption text-muted">Only admins can see and choose workflows.</p>
              ) : workflows.length === 0 ? (
                <p className="text-caption text-muted">
                  No workflows yet.{' '}
                  <Link to="/automations?tab=workflows" className="text-accent-text hover:underline">
                    Add a workflow →
                  </Link>
                </p>
              ) : (
                <fieldset className="space-y-2">
                  <legend className="sr-only">Workflows to run after booking</legend>
                  {workflows.map((w) => {
                    const chosen = value.workflowKeys.includes(w.key);
                    const unmet = unmetInputs(w);
                    const blocked = w.askFirst || !w.isActive || unmet.length > 0;
                    return (
                      <Checkbox
                        key={w.id}
                        label={
                          <span className="flex flex-wrap items-center gap-2">
                            {w.name} <code className="font-mono text-label text-muted">{w.key}</code>
                            {!w.isActive && <Badge tone="slate">inactive</Badge>}
                            {w.askFirst && <Badge tone="amber">asks the team first, so it can't run on its own</Badge>}
                            {unmet.length > 0 && <Badge tone="amber">needs {unmet.join(', ')} from the chat</Badge>}
                          </span>
                        }
                        disabled={!chosen && (blocked || value.workflowKeys.length >= 10)}
                        checked={chosen}
                        onChange={(e) => set('workflowKeys', e.target.checked ? [...value.workflowKeys, w.key] : value.workflowKeys.filter((k) => k !== w.key))}
                      />
                    );
                  })}
                  <p className="text-caption text-muted">Each run gets appointment_id, appointment_time and appointment_timezone, plus values from the contact record.</p>
                </fieldset>
              )}
              {shown.workflows && <p className="mt-1.5 text-caption text-danger-text">{shown.workflows}</p>}
            </BookingOption>
            <BookingOption
              label="Transfer Employee post appointment booking"
              description="Transfer to a specified Employee on successful appointment booking"
              checked={value.transferEmployee}
              onChange={(v) => set('transferEmployee', v)}
            >
              <Field label="Employee" required error={shown.transfer} hint="The conversation is assigned to them, and they're notified.">
                <Select value={value.transferUserId ?? ''} onChange={(e) => set('transferUserId', e.target.value || null)}>
                  <option value="">Select employee</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name || m.email}
                    </option>
                  ))}
                  {value.transferUserId && !members.some((m) => m.userId === value.transferUserId) && <option value={value.transferUserId}>A former team member: choose another</option>}
                </Select>
              </Field>
            </BookingOption>
          </div>

          <div className="space-y-4 p-4">
            <BookingSwitch
              label="Allow bot to cancel the appointment"
              tip="The calendar's change policy still applies: the bot can't cancel too close to the appointment."
              description="Enable this option to allow the AI bot to cancel any existing appointments. Any appointments can be cancelled by the bot based on the appointment's setting."
              checked={value.allowCancel}
              onChange={(v) => set('allowCancel', v)}
            />
            <BookingSwitch
              label="Allow bot to reschedule the appointment"
              tip="The calendar's change policy still applies: the bot can't move an appointment too close to its time."
              description="Enable this option to allow the AI bot to reschedule any existing appointments. Any appointments can be rescheduled by the bot based on the appointment's setting."
              checked={value.allowReschedule}
              onChange={(v) => set('allowReschedule', v)}
            />
            {note && (
              <div role="note" className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2 p-3 text-body-sm text-fg-2">
                <Info className="mt-0.5 size-4 shrink-0 text-fg" aria-hidden />
                <p className="min-w-0 flex-1">
                  <b className="text-fg">Note:</b> Make sure your prompt doesn't include any instructions like <b className="text-fg">'I cannot help with cancellations or rescheduling'</b> When you
                  enable these features, the bot will be able to cancel and reschedule appointments based on the appointment's setting.
                </p>
                <IconButton label="Dismiss note" size="sm" onClick={() => setNote(false)}>
                  <X className="size-4" />
                </IconButton>
              </div>
            )}
          </div>

          <div className="space-y-4 p-4">
            <p className="text-label font-semibold uppercase tracking-wide text-muted">More booking settings</p>
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-body-sm font-semibold text-fg">Details needed before booking</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {BOOKING_FIELDS.map((f) => (
                  <Checkbox
                    key={f}
                    label={f.charAt(0).toUpperCase() + f.slice(1)}
                    checked={value.requiredFields.includes(f)}
                    onChange={(e) => set('requiredFields', e.target.checked ? [...value.requiredFields, f] : value.requiredFields.filter((x) => x !== f))}
                  />
                ))}
              </div>
              <p className="text-caption text-muted">
                {value.requiredFields.length === 0
                  ? 'No details are needed for the booking itself: the agent books as soon as the time is confirmed.'
                  : 'The agent collects these before it books.'}
                {contactInfoAsks && ` Contact Info is also on. ${contactInfoAsks} The agent still collects those as set there, whatever is ticked here; this list only adds what a booking itself needs.`}
              </p>
            </fieldset>
            <BookingSwitch
              label="Only book qualified leads"
              description={qualificationOn ? 'The bot books only after the lead passes Lead Qualification.' : 'Set up Lead Qualification under Actions first.'}
              disabled={!qualificationOn && !value.requireQualification}
              checked={value.requireQualification}
              onChange={(v) => set('requireQualification', v)}
            />
            <BookingSwitch label="Ask the team before booking" description="Bookings, changes and cancellations wait for a team member's approval." checked={ask} onChange={setAsk} />
            <Field label="Appointment title" hint={`Used when the customer doesn't name the kind of visit. Left empty, it is “${DEFAULT_APPOINTMENT_TITLE}”.`}>
              <Input value={value.appointmentTitle} maxLength={120} placeholder={DEFAULT_APPOINTMENT_TITLE} onChange={(e) => set('appointmentTitle', e.target.value)} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Trigger a Workflow: which of the organization's workflows the agent may run. */
export function WorkflowModal({ open, keys, ctx, onApply, onClose }: { open: boolean; keys: string[]; ctx: EditorContext; onApply: (keys: string[]) => void; onClose: () => void }) {
  const [value, setValue] = useLocal(open, keys);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Trigger a Workflow"
      description="Let the agent run your workflows (n8n) during the conversation"
      footer={
        <Footer onRemove={keys.length ? () => onApply([]) : null} onCancel={onClose}>
          <Button variant="primary" disabled={!value.length} onClick={() => onApply(value)}>
            Save action
          </Button>
        </Footer>
      }
    >
      {ctx.workflows === null ? (
        <p className="text-body text-muted">Only admins can see and choose workflows.</p>
      ) : ctx.workflows.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          description="Connect an n8n workflow to let the agent update your CRM, send quotes and more."
          action={
            <Link to="/automations?tab=workflows" className="font-medium text-accent-text hover:underline">
              Add a workflow →
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {ctx.workflows.map((w) => (
            <Checkbox
              key={w.id}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {w.name} <code className="font-mono text-label text-muted">{w.key}</code>
                  {!w.isActive && <Badge tone="slate">inactive</Badge>}
                  {w.askFirst && <Badge tone="amber">asks the team first</Badge>}
                </span>
              }
              description={w.description}
              checked={value.includes(w.key)}
              onChange={(e) => setValue(e.target.checked ? [...value, w.key] : value.filter((k) => k !== w.key))}
            />
          ))}
          <Link to="/automations?tab=workflows" className="inline-block text-body-sm text-accent-text hover:underline">
            Manage workflows →
          </Link>
        </div>
      )}
    </Modal>
  );
}

/** One of the bot's existing settings sections in a modal: Save action switches the feature on with it. */
function SectionModal<T>({
  open,
  title,
  description,
  value,
  enabled,
  onApply,
  onRemove,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  value: T;
  enabled: boolean;
  onApply: (value: T) => void;
  onRemove: (() => void) | null;
  onClose: () => void;
  children: (value: T, set: (v: T) => void) => ReactNode;
}) {
  const [local, setLocal] = useLocal(open, value);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={title}
      description={description}
      footer={
        <Footer onRemove={enabled ? onRemove : null} onCancel={onClose}>
          <Button variant="primary" onClick={() => onApply(local)}>
            Save action
          </Button>
        </Footer>
      }
    >
      <div className="space-y-4">{children(local, setLocal)}</div>
    </Modal>
  );
}

export function ContactInfoModal({ open, value, ctx, onApply, onClose }: { open: boolean; value: LeadCapture; ctx: EditorContext; onApply: (v: LeadCapture) => void; onClose: () => void }) {
  return (
    <SectionModal
      open={open}
      title="Contact Info"
      description="Collect and save the customer's details"
      value={value}
      enabled={value.enabled}
      onApply={(v) => onApply({ ...v, enabled: true })}
      onRemove={() => onApply({ ...value, enabled: false })}
      onClose={onClose}
    >
      {(v, set) => <LeadCaptureSection value={v} onChange={set} ctx={ctx} />}
    </SectionModal>
  );
}

export function QualificationModal({ open, value, ctx, onApply, onClose }: { open: boolean; value: Qualification; ctx: EditorContext; onApply: (v: Qualification) => void; onClose: () => void }) {
  return (
    <SectionModal
      open={open}
      title="Lead Qualification"
      description="Ask your questions, score the answers and tag the lead"
      value={value}
      enabled={value.enabled}
      onApply={onApply}
      onRemove={() => onApply({ ...value, enabled: false })}
      onClose={onClose}
    >
      {(v, set) => <QualificationSection value={v} onChange={set} ctx={ctx} />}
    </SectionModal>
  );
}

export function ToolsModal({ open, value, ctx, onApply, onClose }: { open: boolean; value: Actions; ctx: EditorContext; onApply: (v: Actions) => void; onClose: () => void }) {
  return (
    <SectionModal
      open={open}
      title="Tools, CRM & approvals"
      description="What the agent may do on its own, keep up to date in the CRM, and ask the team about first"
      value={value}
      enabled={false}
      onApply={onApply}
      onRemove={null}
      onClose={onClose}
    >
      {(v, set) => <ActionsSection value={v} onChange={set} ctx={ctx} />}
    </SectionModal>
  );
}

const SOON: Record<'transfer' | 'followup', { title: string; text: string }> = {
  transfer: { title: 'Transfer Bot', text: 'Hand the conversation to another agent.' },
  followup: { title: 'Auto Followup', text: 'Message the customer again when they go quiet.' },
};

/** Listed so the menu matches GHL; not on the platform yet. */
export function ComingSoonActionModal({ which, onClose }: { which: keyof typeof SOON | null; onClose: () => void }) {
  const info = which ? SOON[which] : null;
  return (
    <Modal
      open={Boolean(info)}
      onClose={onClose}
      size="sm"
      title={info?.title ?? ''}
      description={info?.text}
      footer={
        <Button variant="primary" onClick={onClose}>
          Got it
        </Button>
      }
    >
      <p className="flex items-start gap-2 text-body text-fg-2">
        <Info className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden />
        This action is coming soon. For now, Human Handover passes a conversation to your team, and the team can take any conversation over from the inbox.
      </p>
    </Modal>
  );
}
