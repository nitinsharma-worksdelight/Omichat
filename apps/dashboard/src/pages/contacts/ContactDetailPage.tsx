import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Brain, CalendarDays, MessagesSquare, Plus, RotateCcw, Save, Sparkles, StickyNote, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { EventRow } from '../../components/activity';
import { PersonAvatar } from '../../components/avatar';
import { useConfirm } from '../../components/feedback-context';
import { AppointmentStatusBadge, ChannelBadge, ConversationStatusBadge, QualificationBadge, TagChip, TierBadge } from '../../components/status';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  cx,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  NumberInput,
  PageHeader,
  Select,
  SkeletonRows,
  Tabs,
  Textarea,
} from '../../components/ui';
import { ApiError, del, get, patch, post } from '../../lib/api';
import { displayValue, formatDate, formatDateTime, timeAgo } from '../../lib/format';
import { timezones } from '../../lib/hooks';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useBots, useCustomFields, useOrg, useTags } from '../../lib/queries';
import { Link, navigate } from '../../lib/router';
import { ContactDeals } from '../deals/DealsPage';
import type {
  Member,
  Appointment,
  ConsentRecord,
  ConsentSource,
  Contact,
  ContactSummary,
  ConversationListItem,
  CustomFieldDef,
  EventItem,
  MergeCandidate,
  Note,
  QualificationQuestion,
  Task,
} from '../../lib/types';

type Tab = 'activity' | 'notes' | 'tasks' | 'deals' | 'appointments' | 'conversations';

export function ContactDetailPage({ contactId }: { contactId: string }) {
  const { role } = useAuth();
  const canEdit = roleAtLeast(role, 'agent');
  const confirm = useConfirm();
  const contact = useQuery({ queryKey: ['contact', contactId], queryFn: () => get<Contact>(`/v1/contacts/${contactId}`) });
  const [tab, setTab] = useState<Tab>('activity');
  const remove = useAction(() => del(`/v1/contacts/${contactId}`), {
    invalidate: [['contacts']],
    success: 'Contact deleted',
    onSuccess: () => navigate('/contacts'),
  });

  if (contact.isLoading) {
    return (
      <div>
        <PageHeader title="Loading…" />
        <SkeletonRows rows={8} className="px-4 sm:px-8" />
      </div>
    );
  }
  if (contact.error || !contact.data) {
    return (
      <div>
        <PageHeader title="Contact" actions={<Button onClick={() => navigate('/contacts')}>Back to leads</Button>} />
        <ErrorBanner className="m-8" error={contact.error} onRetry={() => void contact.refetch()} />
      </div>
    );
  }
  const c = contact.data;
  const name = c.name || c.email || c.phone || 'Anonymous visitor';

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link to="/contacts" className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg" aria-label="Back to leads">
              <ArrowLeft className="size-4" />
            </Link>
            <PersonAvatar name={c.name || c.email || c.phone} size="lg" className="size-11 text-body" />
            <span className="truncate">{name}</span>
            <span className="flex items-center gap-1.5 font-sans">
              {c.leadTier && <TierBadge tier={c.leadTier} />}
              <QualificationBadge status={c.qualificationStatus} />
              {c.isTest && <Badge tone="blue">Test</Badge>}
            </span>
          </span>
        }
        description={`Score ${c.leadScore} · ${c.lifecycleStage} · from ${c.firstTouch?.utmSource ?? c.sourceChannel ?? 'your team'} · first seen ${formatDate(c.createdAt)}${c.leadCapturedAt ? ` · lead since ${formatDate(c.leadCapturedAt)}` : ''}`}
        actions={
          roleAtLeast(role, 'admin') && (
            <Button
              variant="danger-ghost"
              size="sm"
              icon={<Trash2 className="size-3.5" />}
              onClick={async () => {
                if (await confirm({ title: `Delete ${name}?`, message: 'This deletes the contact with their conversations, notes and appointments. It cannot be undone.', confirmLabel: 'Delete contact', danger: true }))
                  remove.mutate();
              }}
            >
              Delete
            </Button>
          )
        }
      />
      <DuplicateReviews contact={c} canEdit={canEdit} />
      <div className="grid grid-cols-1 gap-6 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(340px,420px)_1fr]">
        <div className="space-y-4">
          <ProfileCard contact={c} canEdit={canEdit} />
          <SourceCard contact={c} />
          <TagsCard contact={c} canEdit={canEdit} />
          <QualificationCard contact={c} canEdit={canEdit} />
          <ConsentCard contact={c} canEdit={canEdit} />
          <MemoryCard contact={c} canEdit={canEdit} />
        </div>
        <Card className="min-w-0 self-start">
          <Tabs<Tab>
            className="border-b border-border px-4"
            value={tab}
            onChange={setTab}
            ariaLabel="Contact history"
            tabs={[
              { id: 'activity', label: 'Activity' },
              { id: 'notes', label: 'Notes' },
              { id: 'tasks', label: 'Tasks' },
              { id: 'deals', label: 'Deals' },
              { id: 'appointments', label: 'Appointments' },
              { id: 'conversations', label: 'Conversations' },
            ]}
          />
          <div className="p-5">
            {tab === 'activity' && <ActivityTab contactId={c.id} />}
            {tab === 'notes' && <NotesTab contactId={c.id} canEdit={canEdit} />}
            {tab === 'tasks' && <TasksTab contactId={c.id} canEdit={canEdit} />}
            {tab === 'deals' && <ContactDeals contact={c} canEdit={canEdit} />}
            {tab === 'appointments' && <AppointmentsTab contactId={c.id} />}
            {tab === 'conversations' && <ConversationsTab contactId={c.id} />}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------- Duplicate reviews ----------

const personName = (p: ContactSummary) => p.name || p.email || p.phone || 'Anonymous visitor';

/**
 * Someone gave an email/phone in a chat that belongs to another contact. Nothing is merged automatically,
 * because anyone can type someone else's details: staff decide here.
 */
function DuplicateReviews({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const confirm = useConfirm();
  const reviews = useQuery({
    queryKey: ['merge-candidates', contact.id],
    queryFn: () => get<MergeCandidate[]>(`/v1/contacts/${contact.id}/merge-candidates`),
  });
  const refresh = [['merge-candidates'], ['contacts'], ['contact'], ['contact-events'], ['contact-conversations'], ['contact-appointments'], ['contact-notes'], ['tasks']];
  const merge = useAction((r: MergeCandidate) => post<Contact>(`/v1/contacts/${r.claimant.id}/merge`, { intoContactId: r.existing.id }), {
    invalidate: refresh,
    success: 'Contacts merged',
    onSuccess: (merged, r) => {
      // This page's contact was merged away: continue on the surviving record.
      if (r.claimant.id === contact.id) navigate(`/contacts/${merged.id}`);
    },
  });
  const dismiss = useAction((r: MergeCandidate) => post(`/v1/merge-candidates/${r.id}/dismiss`), {
    invalidate: [['merge-candidates'], ['contacts']],
    success: 'Kept as separate contacts',
  });
  if (!reviews.data?.length) return null;

  return (
    <div className="space-y-2 px-4 sm:px-8 pt-6">
      {reviews.data.map((r) => {
        const isClaimant = r.claimant.id === contact.id;
        const other = isClaimant ? r.existing : r.claimant;
        const what = r.field === 'phone' ? 'phone number' : 'email';
        const mixesTestData = r.claimant.isTest !== r.existing.isTest;
        return (
          <div key={r.id} role="alert" className="flex flex-wrap items-start gap-3 rounded-xl border border-warning/35 bg-warning-soft px-4 py-3.5 text-body-sm text-fg">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning" aria-hidden>
              <Users className="size-4" />
            </span>
            <div className="min-w-[12rem] flex-1 space-y-1">
              <p>
                {isClaimant ? (
                  <>
                    This visitor gave the {what} <span className="font-medium">{r.value}</span> in a chat. It belongs to{' '}
                    <Link to={`/contacts/${other.id}`} className="font-medium text-accent-text hover:underline">
                      {personName(other)}
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    <Link to={`/contacts/${other.id}`} className="font-medium text-accent-text hover:underline">
                      {personName(other)}
                    </Link>{' '}
                    gave this contact&apos;s {what} (<span className="font-medium">{r.value}</span>) in a chat.
                  </>
                )}{' '}
                {other.isTest && <Badge tone="blue">Test</Badge>}
              </p>
              <p className="text-muted">
                Nothing was merged: anyone can type someone else&apos;s details. Merge only if you know they&apos;re the same person.
                {mixesTestData && ' Test contacts can’t be merged with real ones.'}
              </p>
            </div>
            {canEdit && (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={mixesTestData}
                  loading={merge.isPending && merge.variables?.id === r.id}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Merge into ${personName(r.existing)}?`,
                      message: `${personName(r.claimant)}'s conversations, appointments, notes, tasks and tags move to ${personName(r.existing)}. This can't be undone.`,
                      confirmLabel: 'Merge contacts',
                    });
                    if (ok) merge.mutate(r);
                  }}
                >
                  Merge
                </Button>
                <Button size="sm" variant="ghost" loading={dismiss.isPending && dismiss.variables?.id === r.id} onClick={() => dismiss.mutate(r)}>
                  Not the same person
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Profile ----------

interface ProfileForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  /** IANA name; '' = unknown. */
  timezone: string;
  lifecycleStage: string;
  /** '' = no owner. */
  ownerUserId: string;
  customFields: Record<string, unknown>;
}

function toForm(c: Contact): ProfileForm {
  return {
    firstName: c.firstName ?? '',
    lastName: c.lastName ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    company: c.company ?? '',
    timezone: c.timezone ?? '',
    lifecycleStage: c.lifecycleStage,
    ownerUserId: c.ownerUserId ?? '',
    customFields: { ...c.customFields },
  };
}

function ProfileCard({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const qc = useQueryClient();
  const org = useOrg();
  const fields = useCustomFields();
  const [form, setForm] = useState(() => toForm(contact));
  const base = useMemo(() => toForm(contact), [contact]);
  // Adopt server changes (e.g. the AI captured an email) while the user has nothing unsaved.
  const [lastSeen, setLastSeen] = useState(contact.updatedAt);
  const dirtyKeys = (Object.keys(base) as Array<keyof ProfileForm>).filter((k) => JSON.stringify(form[k]) !== JSON.stringify(base[k]));
  useEffect(() => {
    if (contact.updatedAt !== lastSeen) {
      setLastSeen(contact.updatedAt);
      if (!dirtyKeys.length) setForm(toForm(contact));
    }
  }, [contact.updatedAt]);

  const save = useAction(
    () => {
      const body: Record<string, unknown> = {};
      for (const k of ['firstName', 'lastName', 'email', 'phone', 'company'] as const) if (form[k] !== base[k]) body[k] = form[k].trim() || null;
      if (form.lifecycleStage !== base.lifecycleStage) body.lifecycleStage = form.lifecycleStage;
      if (form.ownerUserId !== base.ownerUserId) body.ownerUserId = form.ownerUserId || null;
      if (form.timezone !== base.timezone) body.timezone = form.timezone || null;
      const changedFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form.customFields)) if (JSON.stringify(v) !== JSON.stringify(base.customFields[k])) changedFields[k] = v === '' ? null : v;
      if (Object.keys(changedFields).length) body.customFields = changedFields;
      return patch<Contact>(`/v1/contacts/${contact.id}`, body);
    },
    {
      errorToast: false,
      success: 'Contact saved',
      onSuccess: (updated) => {
        qc.setQueryData(['contact', contact.id], updated);
        setForm(toForm(updated));
        void qc.invalidateQueries({ queryKey: ['contacts'] });
        void qc.invalidateQueries({ queryKey: ['contact-events', contact.id] });
      },
    },
  );

  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setCustom = (key: string, v: unknown) => setForm((f) => ({ ...f, customFields: { ...f.customFields, [key]: v } }));
  const stages = org.data?.settings.lifecycleStages ?? [];
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<Member[]>('/v1/members'), staleTime: 60_000 });
  const tzList = useMemo(() => timezones(), []);
  const unknownKeys = Object.keys(contact.customFields).filter((k) => !(fields.data ?? []).some((f) => f.key === k));

  return (
    <Card>
      <CardHeader
        title="Profile"
        actions={
          canEdit &&
          dirtyKeys.length > 0 && (
            <>
              <Button size="xs" variant="ghost" onClick={() => setForm(base)}>
                Discard
              </Button>
              <Button size="xs" variant="primary" icon={<Save className="size-3" />} loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
            </>
          )
        }
      />
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirtyKeys.length) save.mutate();
        }}
      >
        {save.error ? <ErrorBanner error={save.error} details={save.error instanceof ApiError ? save.error.details : undefined} title={save.error instanceof ApiError && save.error.details.length ? save.error.message : undefined} /> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First name">
            <Input value={form.firstName} disabled={!canEdit} onChange={(e) => set('firstName', e.target.value)} />
          </Field>
          <Field label="Last name">
            <Input value={form.lastName} disabled={!canEdit} onChange={(e) => set('lastName', e.target.value)} />
          </Field>
        </div>
        <Field label="Email">
          <Input type="email" value={form.email} disabled={!canEdit} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Phone">
            <Input type="tel" value={form.phone} disabled={!canEdit} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Company">
            <Input value={form.company} disabled={!canEdit} onChange={(e) => set('company', e.target.value)} />
          </Field>
        </div>
        <Field label="Timezone" hint="From their browser, or what they told the assistant. Booking times are also shown to them in it.">
          <Select value={form.timezone} disabled={!canEdit} onChange={(e) => set('timezone', e.target.value)}>
            <option value="">Unknown</option>
            {form.timezone && !tzList.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
            {tzList.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Lifecycle stage">
            <Select value={form.lifecycleStage} disabled={!canEdit} onChange={(e) => set('lifecycleStage', e.target.value)}>
              {!stages.includes(form.lifecycleStage) && <option value={form.lifecycleStage}>{form.lifecycleStage}</option>}
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Owner">
            <Select value={form.ownerUserId} disabled={!canEdit} onChange={(e) => set('ownerUserId', e.target.value)}>
              <option value="">No owner</option>
              {form.ownerUserId && !(members.data ?? []).some((m) => m.userId === form.ownerUserId) && <option value={form.ownerUserId}>Former member</option>}
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name || m.email}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {(fields.data ?? []).length > 0 && (
          <div className="space-y-3 border-t border-border pt-3">
            <p className="text-caption font-medium tracking-wide text-muted uppercase">Custom fields</p>
            {(fields.data ?? []).map((def) => (
              <CustomFieldInput key={def.id} def={def} value={form.customFields[def.key]} disabled={!canEdit} onChange={(v) => setCustom(def.key, v)} />
            ))}
          </div>
        )}
        {unknownKeys.length > 0 && (
          <div className="space-y-1 border-t border-border pt-3 text-body-sm">
            <p className="text-caption text-muted">Other stored fields</p>
            {unknownKeys.map((k) => (
              <p key={k}>
                <span className="text-muted">{k}:</span> {displayValue(contact.customFields[k])}
              </p>
            ))}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Card>
  );
}

function CustomFieldInput({ def, value, onChange, disabled }: { def: CustomFieldDef; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const label = (
    <>
      {def.label} <span className="font-normal text-faint">({def.key})</span>
    </>
  );
  switch (def.type) {
    case 'number':
      return (
        <Field label={label} hint={def.description || undefined}>
          <NumberInput value={typeof value === 'number' ? value : value === null || value === undefined || value === '' ? null : Number(value)} allowEmpty disabled={disabled} onChange={onChange} />
        </Field>
      );
    case 'boolean':
      return (
        <Field label={label} hint={def.description || undefined}>
          <Select value={value === true ? 'true' : value === false ? 'false' : ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}>
            <option value="">—</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </Select>
        </Field>
      );
    case 'select':
      return (
        <Field label={label} hint={def.description || undefined}>
          <Select value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">—</option>
            {def.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
      );
    default: {
      const type = def.type === 'date' ? 'date' : def.type === 'email' ? 'email' : def.type === 'phone' ? 'tel' : def.type === 'url' ? 'url' : 'text';
      return (
        <Field label={label} hint={def.description || undefined}>
          <Input type={type} value={value === null || value === undefined ? '' : String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    }
  }
}

// ---------- Tags ----------

function TagsCard({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const tags = useTags();
  const [text, setText] = useState('');
  const invalidate = [['contact', contact.id], ['contacts'], ['tags'], ['contact-events', contact.id]];
  const add = useAction((name: string) => post<{ added: string[]; skipped: string[] }>(`/v1/contacts/${contact.id}/tags`, { tags: [name] }), {
    invalidate,
    onSuccess: () => setText(''),
  });
  const remove = useAction((tagId: string) => del(`/v1/contacts/${contact.id}/tags/${tagId}`), { invalidate });
  const available = (tags.data ?? []).filter((t) => !contact.tags.some((ct) => ct.id === t.id));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) add.mutate(text.trim());
  };
  return (
    <Card>
      <CardHeader title="Tags" />
      <div className="space-y-3 p-4">
        {contact.tags.length === 0 ? (
          <p className="text-body-sm text-muted">No tags yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {contact.tags.map((t) => (
              <TagChip key={t.id} name={t.name} color={t.color} onRemove={canEdit ? () => remove.mutate(t.id) : undefined} />
            ))}
          </div>
        )}
        {canEdit && (
          <form className="flex gap-2" onSubmit={submit}>
            <Input aria-label="Add a tag" list="contact-tag-options" placeholder="Add a tag (new names are created)" value={text} onChange={(e) => setText(e.target.value)} />
            <datalist id="contact-tag-options">
              {available.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
            <Button type="submit" size="md" loading={add.isPending} disabled={!text.trim()}>
              Add
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

// ---------- Qualification ----------

function QualificationCard({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const bots = useBots();
  const confirm = useConfirm();
  // The asking assistant's current question for each answer (or, for answers from before assistants were tracked,
  // the first one with that key), and whether the stored answer still fits it.
  const describe = useMemo(() => {
    const list = bots.data ?? [];
    return (key: string, answer: { value: unknown; botId?: string | null }) => {
      const asker = answer.botId ? list.find((b) => b.id === answer.botId) : undefined;
      const question = (asker ? [asker] : list).flatMap((b) => b.config.qualification.questions).find((q) => q.key === key);
      return { question, asker: asker?.name ?? null, fits: question ? answerFits(question, answer.value) : false };
    };
  }, [bots.data]);
  const reset = useAction(() => post(`/v1/contacts/${contact.id}/qualification/reset`), {
    invalidate: [['contact', contact.id], ['contacts'], ['contact-events', contact.id]],
    success: 'Qualification reset',
  });
  const answers = Object.entries(contact.qualification ?? {});
  return (
    <Card>
      <CardHeader
        title="Qualification"
        description={`Score ${contact.leadScore}${contact.leadTier ? ` · ${contact.leadTier}` : ''}`}
        actions={
          canEdit &&
          answers.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              icon={<RotateCcw className="size-3" />}
              loading={reset.isPending}
              onClick={async () => {
                if (await confirm({ title: 'Reset qualification?', message: 'Clears the answers and score so the assistant asks the questions again.', confirmLabel: 'Reset' })) reset.mutate();
              }}
            >
              Reset
            </Button>
          )
        }
      />
      <div className="p-4">
        {answers.length === 0 ? (
          <p className="text-body-sm text-muted">No answers yet. The assistant asks your qualification questions during the chat.</p>
        ) : (
          <dl className="space-y-2.5">
            {answers.map(([key, a]) => {
              const { question, asker, fits } = describe(key, a);
              return (
                <div key={key}>
                  <dt className="text-caption text-muted">
                    {question?.question ?? key}{' '}
                    <span className="text-faint">
                      · {timeAgo(a.answeredAt)}
                      {asker ? ` · asked by ${asker}` : ''}
                    </span>
                  </dt>
                  <dd className={cx('text-body-sm', fits ? 'text-fg' : 'text-muted line-through')}>{displayValue(a.value)}</dd>
                  {!fits && (
                    <p className="text-label text-warning-text">
                      {question ? "Doesn't fit the current question any more: the assistant will ask again." : 'No assistant asks this question any more.'}
                    </p>
                  )}
                </div>
              );
            })}
          </dl>
        )}
      </div>
    </Card>
  );
}

/** Mirrors the server's check: does a stored answer still fit the question as it is now? */
function answerFits(q: QualificationQuestion, value: unknown): boolean {
  const option = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return Boolean(s) && q.options.some((o) => o.toLowerCase() === s || (s.length >= 3 && o.toLowerCase().startsWith(s)));
  };
  switch (q.type) {
    case 'select':
      return option(value);
    case 'multi_select':
      return (Array.isArray(value) ? value : [value]).some(option);
    case 'number':
      // Like the server: "$50k", "1,200" and "1.5 lakh" read as numbers.
      return typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?(k|m|b|lakh|lac|cr|crore)?$/.test(value.trim().toLowerCase().replace(/[$€£₹,\s]/g, '')));
    case 'boolean':
      return typeof value === 'boolean' || (typeof value === 'string' && ['yes', 'y', 'true', '1', 'yeah', 'yep', 'sure', 'no', 'n', 'false', '0', 'nope', 'not really'].includes(value.trim().toLowerCase()));
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    default:
      return value !== null && value !== undefined && value !== '';
  }
}

// ---------- Source and consent ----------

function SourceCard({ contact }: { contact: Contact }) {
  const t = contact.firstTouch;
  const adClick = t?.gclid ? 'Google Ads' : t?.fbclid ? 'Meta ads' : t?.msclkid ? 'Microsoft Ads' : null;
  const rows: Array<[string, string | null | undefined]> = t
    ? [
        ['Landing page', t.landingPage],
        ['Referred by', t.referrer],
        ['Campaign', [t.utmSource, t.utmMedium, t.utmCampaign].filter(Boolean).join(' / ') || null],
        ['Term', t.utmTerm],
        ['Content', t.utmContent],
        ['Ad click', adClick],
        ['First visit', t.at ? formatDateTime(t.at) : null],
      ]
    : [];
  return (
    <Card>
      <CardHeader title="Source" description={contact.sourceChannel ? `First channel: ${contact.sourceChannel}` : 'Added by your team'} />
      <div className="p-4">
        {!t ? (
          <p className="text-body-sm text-muted">No website visit or campaign recorded.</p>
        ) : (
          <dl className="space-y-2">
            {rows
              .filter(([, v]) => v)
              .map(([label, v]) => (
                <div key={label}>
                  <dt className="text-caption text-muted">{label}</dt>
                  <dd className="text-body-sm break-all text-fg">{v}</dd>
                </div>
              ))}
          </dl>
        )}
      </div>
    </Card>
  );
}

const consentSource = (s: ConsentSource) => (s === 'chat' ? 'in chat' : s === 'staff' ? 'by staff' : 'from an integration');

function ConsentCard({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const history = useQuery({ queryKey: ['contact-consents', contact.id], queryFn: () => get<ConsentRecord[]>(`/v1/contacts/${contact.id}/consents`) });
  // Recording by staff: which answer, and the note saying how the customer gave it.
  const [recording, setRecording] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const close = () => {
    setRecording(null);
    setNote('');
  };
  const record = useAction((granted: boolean) => post<ConsentRecord>(`/v1/contacts/${contact.id}/consents`, { purpose: 'marketing', granted, note: note.trim() }), {
    invalidate: [['contact', contact.id], ['contacts'], ['contact-consents', contact.id], ['contact-events', contact.id]],
    success: 'Consent recorded',
    onSuccess: close,
  });
  const state = contact.consent.marketing;
  return (
    <Card>
      <CardHeader
        title="Marketing consent"
        description={state ? `${state.granted ? 'Opted in' : 'Declined or withdrew'} ${consentSource(state.source)} · ${timeAgo(state.at)}` : 'Not asked yet'}
        actions={
          canEdit &&
          recording === null && (
            <span className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => setRecording(true)}>
                Record opt-in
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setRecording(false)}>
                Record opt-out
              </Button>
            </span>
          )
        }
      />
      <div className="space-y-3 p-4">
        {recording !== null && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) record.mutate(recording);
            }}
          >
            <Field label={recording ? 'How did they agree?' : 'How did they ask to stop?'}>
              <Input
                autoFocus
                maxLength={500}
                placeholder={recording ? 'e.g. Agreed by phone on 5 October' : 'e.g. Asked by email to stop offers'}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="primary" loading={record.isPending} disabled={!note.trim()}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {history.data?.length ? (
          <ul className="space-y-2.5">
            {history.data.map((r) => (
              <li key={r.id} className="text-body-sm">
                <p className="text-fg">
                  {r.granted ? 'Opted in' : 'Declined or withdrew'}{' '}
                  <span className="text-muted">
                    · {consentSource(r.source)} · {formatDateTime(r.createdAt)}
                  </span>
                </p>
                {r.text && <p className="text-caption text-muted">Shown: “{r.text}”</p>}
                {r.note && <p className="text-caption text-muted">Note: {r.note}</p>}
                {r.conversationId && (
                  <Link to={`/conversations/${r.conversationId}`} className="text-caption text-accent-text hover:underline">
                    See the conversation
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !history.isLoading && <p className="text-body-sm text-muted">No consent recorded.</p>
        )}
      </div>
    </Card>
  );
}

function MemoryCard({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const [text, setText] = useState('');
  const invalidate = [['contact', contact.id], ['contact-events', contact.id]];
  const add = useAction(() => post(`/v1/contacts/${contact.id}/memory`, { text: text.trim() }), {
    invalidate,
    success: 'The assistant will remember this',
    onSuccess: () => setText(''),
  });
  const remove = useAction((id: string) => del(`/v1/contacts/${contact.id}/memory/${id}`), { invalidate, success: 'The assistant will forget this' });
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-ai-soft text-ai" aria-hidden>
              <Sparkles className="size-3.5" />
            </span>
            What the AI remembers
          </span>
        }
        description="The assistant uses these in its conversations with this customer. The team's notes come first and count more than its own."
      />
      <div className="space-y-3 p-4">
        {contact.memory.length === 0 ? (
          <p className="flex items-center gap-2 text-body-sm text-muted">
            <Brain className="size-4" aria-hidden /> Nothing remembered yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {[...contact.memory].reverse().map((m) => (
              <li key={m.id} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-body-sm text-fg">
                <div className="min-w-0 flex-1">
                  {m.text}
                  <span className={cx('mt-0.5 block text-label', m.source === 'user' ? 'text-human-text' : 'text-ai-text')}>
                    {m.source === 'user' ? 'Noted by the team' : 'Noted by the AI'} <span className="text-muted">· {timeAgo(m.createdAt)}</span>
                  </span>
                </div>
                {canEdit && (
                  <IconButton label={`Forget: ${m.text}`} size="sm" disabled={remove.isPending} onClick={() => remove.mutate(m.id)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) add.mutate();
            }}
          >
            <Input
              aria-label="Something the assistant should remember"
              placeholder="e.g. Prefers morning appointments"
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" size="sm" icon={<Plus className="size-3.5" />} loading={add.isPending} disabled={!text.trim()}>
              Add
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

// ---------- Tabs ----------

function ActivityTab({ contactId }: { contactId: string }) {
  const events = useQuery({ queryKey: ['contact-events', contactId], queryFn: () => get<EventItem[]>(`/v1/contacts/${contactId}/events`) });
  if (events.isLoading) return <SkeletonRows rows={5} className="p-0" />;
  if (events.error) return <ErrorBanner error={events.error} />;
  if (!events.data?.length) return <EmptyState title="No activity yet" />;
  return (
    <ul className="divide-y divide-border">
      {events.data.map((e) => (
        <EventRow key={e.id} event={{ ...e, contactId: null }} />
      ))}
    </ul>
  );
}

function NotesTab({ contactId, canEdit }: { contactId: string; canEdit: boolean }) {
  const notes = useQuery({ queryKey: ['contact-notes', contactId], queryFn: () => get<Note[]>(`/v1/contacts/${contactId}/notes`) });
  const [body, setBody] = useState('');
  const [share, setShare] = useState(false);
  const add = useAction((text: string) => post<Note>(`/v1/contacts/${contactId}/notes`, { body: text, shareWithAssistant: share }), {
    invalidate: [['contact-notes', contactId], ['contact-events', contactId], ['contact', contactId]],
    success: share ? 'Note added and shared with the assistant' : 'Note added',
    onSuccess: () => {
      setBody('');
      setShare(false);
    },
  });
  return (
    <div className="space-y-4">
      {canEdit && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) add.mutate(body.trim());
          }}
        >
          <Field label="Add a note">
            <Textarea rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Called back, interested in the premium package…" />
          </Field>
          <Checkbox
            label="The assistant can use this note"
            description="Notes are for your team. Tick this to also add it to what the AI remembers about this customer."
            checked={share}
            onChange={(e) => setShare(e.target.checked)}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" variant="primary" icon={<StickyNote className="size-3.5" />} loading={add.isPending} disabled={!body.trim()}>
              Add note
            </Button>
          </div>
        </form>
      )}
      {notes.isLoading ? (
        <SkeletonRows rows={3} className="p-0" />
      ) : notes.error ? (
        <ErrorBanner error={notes.error} />
      ) : !notes.data?.length ? (
        <p className="py-4 text-center text-body-sm text-muted">No notes yet.</p>
      ) : (
        <ul className="space-y-3">
          {notes.data.map((n) => (
            <li key={n.id} className="rounded-xl border border-border bg-surface px-3.5 py-3 shadow-card">
              <p className="text-body-sm whitespace-pre-wrap text-fg">{n.body}</p>
              <p className="mt-1 text-label text-muted">
                {n.source === 'ai' ? 'AI' : 'Team'} · {formatDateTime(n.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TasksTab({ contactId, canEdit }: { contactId: string; canEdit: boolean }) {
  const tasks = useQuery({ queryKey: ['tasks', { contactId }], queryFn: () => get<Task[]>('/v1/tasks', { contactId }) });
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('normal');
  const create = useAction(
    () => post<Task>('/v1/tasks', { title: title.trim(), contactId, priority, dueAt: dueAt ? new Date(`${dueAt}T09:00:00`).toISOString() : null }),
    {
      invalidate: [['tasks'], ['contact-events', contactId]],
      success: 'Task created',
      onSuccess: () => {
        setTitle('');
        setDueAt('');
        setPriority('normal');
      },
    },
  );
  const toggle = useAction((t: Task) => patch<Task>(`/v1/tasks/${t.id}`, { status: t.status === 'open' ? 'done' : 'open' }), { invalidate: [['tasks']] });
  return (
    <div className="space-y-4">
      {canEdit && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <Field label="New task" className="flex-1">
            <Input value={title} maxLength={200} placeholder="Call back about pricing" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Due">
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Task['priority'])}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </Select>
          </Field>
          <Button type="submit" icon={<Plus className="size-4" />} loading={create.isPending} disabled={!title.trim()}>
            Add
          </Button>
        </form>
      )}
      {tasks.isLoading ? (
        <SkeletonRows rows={3} className="p-0" />
      ) : tasks.error ? (
        <ErrorBanner error={tasks.error} />
      ) : !tasks.data?.length ? (
        <p className="py-4 text-center text-body-sm text-muted">No tasks for this contact.</p>
      ) : (
        <ul className="divide-y divide-border">
          {tasks.data.map((t) => (
            <li key={t.id} className="flex items-start gap-3 py-3">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                checked={t.status === 'done'}
                disabled={!canEdit}
                aria-label={`Mark “${t.title}” as ${t.status === 'open' ? 'done' : 'open'}`}
                onChange={() => toggle.mutate(t)}
              />
              <div className="min-w-0 flex-1">
                <p className={cx('text-body-sm', t.status === 'done' ? 'text-muted line-through' : 'text-fg')}>{t.title}</p>
                {t.description && <p className="text-caption text-muted">{t.description}</p>}
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-label text-muted">
                  {t.priority !== 'normal' && <Badge tone={t.priority === 'high' ? 'red' : 'slate'}>{t.priority}</Badge>}
                  <Badge tone={t.createdBy === 'ai' ? 'ai' : 'human'}>{t.createdBy === 'ai' ? 'by AI' : 'by team'}</Badge>
                  {t.dueAt && <span>Due {formatDate(t.dueAt)}</span>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AppointmentsTab({ contactId }: { contactId: string }) {
  const appts = useQuery({ queryKey: ['contact-appointments', contactId], queryFn: () => get<Appointment[]>(`/v1/contacts/${contactId}/appointments`) });
  if (appts.isLoading) return <SkeletonRows rows={3} className="p-0" />;
  if (appts.error) return <ErrorBanner error={appts.error} />;
  if (!appts.data?.length)
    return (
      <EmptyState
        icon={<CalendarDays className="size-5" />}
        title="No appointments"
        description="Bookings made by the assistant or your team show up here."
        action={
          <Link to="/appointments" className="text-body-sm text-accent-text hover:underline">
            Book one from Appointments →
          </Link>
        }
      />
    );
  return (
    <ul className="divide-y divide-border">
      {appts.data.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-3 py-3">
          <div>
            <p className="text-body-sm font-medium text-fg">{a.title}</p>
            <p className="text-caption text-muted">
              {a.label} ({a.timezone}) · booked by {a.createdBy === 'ai' ? 'AI' : a.createdBy === 'user' ? 'team' : 'contact'}
            </p>
            {a.cancelReason && <p className="text-caption text-danger-text">{a.cancelReason}</p>}
          </div>
          <AppointmentStatusBadge status={a.status} />
        </li>
      ))}
    </ul>
  );
}

function ConversationsTab({ contactId }: { contactId: string }) {
  const convs = useQuery({ queryKey: ['contact-conversations', contactId], queryFn: () => get<ConversationListItem[]>(`/v1/contacts/${contactId}/conversations`) });
  if (convs.isLoading) return <SkeletonRows rows={3} className="p-0" />;
  if (convs.error) return <ErrorBanner error={convs.error} />;
  if (!convs.data?.length) return <EmptyState icon={<MessagesSquare className="size-5" />} title="No conversations" />;
  return (
    <ul className="divide-y divide-border">
      {convs.data.map((c) => (
        <li key={c.id}>
          <Link to={`/conversations/${c.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-surface-2/60">
            <div className="min-w-0">
              <p className="truncate text-body-sm text-fg">{c.lastMessage?.content ?? 'No messages'}</p>
              {c.summaryDetails?.intent ? (
                <p className="mt-0.5 line-clamp-2 text-caption text-muted" title={c.summary ?? undefined}>
                  <Sparkles className="mr-1 inline size-3 align-[-1px] text-ai" aria-hidden />
                  <span className="text-fg-2">Wanted:</span> {c.summaryDetails.intent}
                  {c.summaryDetails.outcome && (
                    <>
                      {' '}
                      · <span className="text-fg-2">Outcome:</span> {c.summaryDetails.outcome}
                    </>
                  )}
                </p>
              ) : (
                c.summary && (
                  <p className="mt-0.5 line-clamp-2 text-caption text-muted" title={c.summary}>
                    {c.summary}
                  </p>
                )
              )}
              <p className="text-caption text-muted">
                {c.messageCount} messages · {timeAgo(c.lastMessageAt ?? c.createdAt)}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1">
              <ConversationStatusBadge status={c.status} />
              <ChannelBadge channel={c.channel} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
