import { CalendarDays, Info, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from '../../../components/overlay';
import { Badge, Button, Checkbox, cx, EmptyState, Field, Input, Select, Toggle } from '../../../components/ui';
import { Link } from '../../../lib/router';
import type { Actions, Booking, BookingRequiredField, Handoff, LeadCapture, Qualification } from '../../../lib/types';
import { ActionsSection, HandoffSection, LeadCaptureSection, QualificationSection, type EditorContext } from '../../bots/sections';

function Footer({ onRemove, onCancel, children }: { onRemove: (() => void) | null; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button variant="danger-ghost" icon={<Trash2 className="size-4" aria-hidden />} disabled={!onRemove} onClick={() => onRemove?.()}>
        Remove
      </Button>
      <span className="flex-1" />
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
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
const BOOKING_ASK = ['book_appointment', 'reschedule_appointment', 'cancel_appointment'] as const;

/** GHL's Appointment Booking: 1 Calendar Selection, 2 Advanced Options. "Save action" turns booking on with them. */
export function BookingModal({
  open,
  booking,
  askFirst,
  qualificationOn,
  ctx,
  onApply,
  onClose,
}: {
  open: boolean;
  booking: Booking;
  askFirst: Actions['askFirst'];
  qualificationOn: boolean;
  ctx: EditorContext;
  onApply: (booking: Booking, askFirst: Actions['askFirst']) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [value, setValue] = useLocal(open, booking);
  const asking = BOOKING_ASK.some((t) => askFirst.includes(t));
  const [ask, setAsk] = useState(asking);
  const calendars = ctx.calendars;
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setAsk(asking);
    // With one calendar, it's the choice.
    if (!booking.calendarId && calendars.length === 1) setValue({ ...structuredClone(booking), calendarId: calendars[0]!.id });
  }, [open]);
  const set = <K extends keyof Booking>(key: K, v: Booking[K]) => setValue({ ...value, [key]: v });
  const calendar = calendars.find((c) => c.id === value.calendarId);
  const save = () => {
    const rest = askFirst.filter((t) => !(BOOKING_ASK as readonly string[]).includes(t));
    onApply({ ...value, enabled: true }, ask ? [...rest, ...BOOKING_ASK] : rest);
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
        <Footer onRemove={booking.enabled ? () => onApply({ ...booking, enabled: false }, askFirst.filter((t) => !(BOOKING_ASK as readonly string[]).includes(t))) : null} onCancel={onClose}>
          {step === 2 && <Button onClick={() => setStep(1)}>Back</Button>}
          <Button variant="primary" disabled={!value.calendarId} onClick={() => (step === 1 ? setStep(2) : save())}>
            {step === 1 ? 'Proceed' : 'Save action'}
          </Button>
        </Footer>
      }
    >
      <ol aria-label="Steps" className="mb-7 flex flex-wrap items-start gap-3">
        {(
          [
            [1, 'Calendar Selection', 'Choose calendar(s) for booking appointments'],
            [2, 'Advanced Options', 'Configure additional booking behaviors'],
          ] as const
        ).map(([n, title, text], i) => (
          <li key={n} className="flex items-start gap-3" aria-current={step === n ? 'step' : undefined}>
            {i > 0 && <span aria-hidden className="mt-4 hidden h-px w-24 bg-border-strong sm:block" />}
            <span className="flex flex-col gap-1.5">
              <span className="flex items-center gap-2.5">
                <span
                  className={cx(
                    'flex size-8 items-center justify-center rounded-full text-body',
                    step === n ? 'bg-accent text-accent-fg' : step > n ? 'bg-accent-soft text-accent-text' : 'border border-border-strong text-faint',
                  )}
                >
                  {n}
                </span>
                <span className={cx('text-[16px]', step >= n ? 'text-fg' : 'text-faint')}>{title}</span>
              </span>
              <span className={cx('pl-[42px] text-body-sm', step >= n ? 'text-fg-2' : 'text-faint')}>{text}</span>
            </span>
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
                    {c.name} ({c.timezone}){c.isActive ? '' : ' — inactive'}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {calendar && !calendar.isActive && <p className="text-body-sm text-warning-text">This calendar is inactive, so it has no open times until you turn it on.</p>}
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <fieldset className="space-y-2">
            <legend className="mb-1.5 font-medium text-fg">Details needed before booking</legend>
            {BOOKING_FIELDS.map((f) => (
              <Checkbox
                key={f}
                label={f.charAt(0).toUpperCase() + f.slice(1)}
                checked={value.requiredFields.includes(f)}
                onChange={(e) => set('requiredFields', e.target.checked ? [...value.requiredFields, f] : value.requiredFields.filter((x) => x !== f))}
              />
            ))}
          </fieldset>
          <div className="space-y-3">
            <Toggle label="Let customers reschedule" checked={value.allowReschedule} onChange={(v) => set('allowReschedule', v)} />
            <Toggle label="Let customers cancel" checked={value.allowCancel} onChange={(v) => set('allowCancel', v)} />
            <Toggle
              label="Only book qualified leads"
              description={qualificationOn ? undefined : 'Set up Lead Qualification under Actions first.'}
              disabled={!qualificationOn && !value.requireQualification}
              checked={value.requireQualification}
              onChange={(v) => set('requireQualification', v)}
            />
            <Toggle label="Ask the team before booking" description="Bookings, changes and cancellations wait for a team member's approval." checked={ask} onChange={setAsk} />
          </div>
          <Field label="Appointment title" hint="Used when the customer doesn't name the kind of visit.">
            <Input value={value.appointmentTitle} maxLength={120} onChange={(e) => set('appointmentTitle', e.target.value)} />
          </Field>
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

export function HandoverModal({ open, value, ctx, onApply, onClose }: { open: boolean; value: Handoff; ctx: EditorContext; onApply: (v: Handoff) => void; onClose: () => void }) {
  return (
    <SectionModal
      open={open}
      title="Human Handover"
      description="Pass the conversation to your team"
      value={value}
      enabled={value.enabled}
      onApply={(v) => onApply({ ...v, enabled: true })}
      onRemove={() => onApply({ ...value, enabled: false })}
      onClose={onClose}
    >
      {(v, set) => <HandoffSection value={v} onChange={set} ctx={ctx} />}
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

const SOON: Record<'stop' | 'transfer' | 'followup', { title: string; text: string }> = {
  stop: { title: 'Stop Bot', text: 'Stop the agent replying when a condition is met.' },
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
