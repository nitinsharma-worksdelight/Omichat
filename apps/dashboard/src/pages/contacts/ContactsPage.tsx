import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Search, Users } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { PersonAvatar } from '../../components/avatar';
import { Modal } from '../../components/overlay';
import { QualificationBadge, TagChip, TierBadge } from '../../components/status';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, SkeletonRows, Table, TD, TH } from '../../components/ui';
import { fieldErrors, get, post } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { useAction } from '../../lib/mutations';
import { isEmail } from '../../lib/validate';
import { roleAtLeast, useOrg, useTags } from '../../lib/queries';
import { Link, navigate, useRoute, withQuery } from '../../lib/router';
import type { Contact, ContactList, LeadTier, QualificationStatus, SourceOptions } from '../../lib/types';

const PAGE_SIZE = 25;

export function ContactsPage() {
  const route = useRoute();
  const q = route.query;
  const org = useOrg();
  const tags = useTags();
  const { role } = useAuth();
  const [creating, setCreating] = useState(false);

  // Filters live in the URL so they survive opening a contact and coming back.
  const filters = {
    search: q.get('search') ?? '',
    lifecycleStage: q.get('stage') ?? '',
    leadTier: (q.get('tier') ?? '') as LeadTier | '',
    qualificationStatus: (q.get('status') ?? '') as QualificationStatus | '',
    tagId: q.get('tag') ?? '',
    utmSource: q.get('source') ?? '',
    utmCampaign: q.get('campaign') ?? '',
    marketingConsent: q.get('consent') ?? '',
    leadsOnly: q.get('leads') === '1',
    includeTest: q.get('test') === '1',
    offset: Math.max(0, Number(q.get('offset') ?? 0) || 0),
  };
  const setFilter = (changes: Record<string, string | null>) => navigate(withQuery(route, { ...changes, offset: null }), { replace: true });

  const [searchText, setSearchText] = useState(filters.search);
  const debouncedSearch = useDebounced(searchText, 300);
  useEffect(() => {
    if (debouncedSearch !== filters.search) setFilter({ search: debouncedSearch || null });
  }, [debouncedSearch]);

  const contacts = useQuery({
    queryKey: ['contacts', filters],
    queryFn: () =>
      get<ContactList>('/v1/contacts', {
        search: filters.search,
        lifecycleStage: filters.lifecycleStage,
        leadTier: filters.leadTier,
        qualificationStatus: filters.qualificationStatus,
        tagId: filters.tagId,
        utmSource: filters.utmSource,
        utmCampaign: filters.utmCampaign,
        marketingConsent: filters.marketingConsent,
        leadsOnly: filters.leadsOnly,
        includeTest: filters.includeTest,
        limit: PAGE_SIZE,
        offset: filters.offset,
      }),
    placeholderData: keepPreviousData,
  });

  const total = contacts.data?.total ?? 0;
  const items = contacts.data?.items ?? [];
  const from = total === 0 ? 0 : filters.offset + 1;
  const to = Math.min(filters.offset + PAGE_SIZE, total);
  const anyFilter = Boolean(
    filters.search ||
      filters.lifecycleStage ||
      filters.leadTier ||
      filters.qualificationStatus ||
      filters.tagId ||
      filters.utmSource ||
      filters.utmCampaign ||
      filters.marketingConsent ||
      filters.leadsOnly,
  );
  const sources = useQuery({ queryKey: ['contact-source-options'], queryFn: () => get<SourceOptions>('/v1/contacts/source-options') });

  return (
    <div>
      <PageHeader
        title="Leads"
        description="Everyone who has chatted with your assistants, with what they told it."
        actions={
          roleAtLeast(role, 'agent') && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Add contact
            </Button>
          )
        }
      />
      <div className="space-y-4 px-4 sm:px-8 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input aria-label="Search contacts" placeholder="Search name, email, phone, company" className="pl-8" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          <Select aria-label="Lifecycle stage" className="w-40" value={filters.lifecycleStage} onChange={(e) => setFilter({ stage: e.target.value || null })}>
            <option value="">All stages</option>
            {(org.data?.settings.lifecycleStages ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select aria-label="Lead tier" className="w-32" value={filters.leadTier} onChange={(e) => setFilter({ tier: e.target.value || null })}>
            <option value="">Any tier</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
          </Select>
          <Select aria-label="Qualification status" className="w-44" value={filters.qualificationStatus} onChange={(e) => setFilter({ status: e.target.value || null })}>
            <option value="">Any qualification</option>
            <option value="not_started">Not started</option>
            <option value="in_progress">In progress</option>
            <option value="qualified">Qualified</option>
            <option value="disqualified">Disqualified</option>
          </Select>
          <Select aria-label="Tag" className="w-40" value={filters.tagId} onChange={(e) => setFilter({ tag: e.target.value || null })}>
            <option value="">Any tag</option>
            {(tags.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          {(sources.data?.utmSource.length ?? 0) > 0 && (
            <Select aria-label="Source" className="w-36" value={filters.utmSource} onChange={(e) => setFilter({ source: e.target.value || null })}>
              <option value="">Any source</option>
              {sources.data!.utmSource.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          )}
          {(sources.data?.utmCampaign.length ?? 0) > 0 && (
            <Select aria-label="Campaign" className="w-40" value={filters.utmCampaign} onChange={(e) => setFilter({ campaign: e.target.value || null })}>
              <option value="">Any campaign</option>
              {sources.data!.utmCampaign.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          )}
          <Select aria-label="Marketing consent" className="w-40" value={filters.marketingConsent} onChange={(e) => setFilter({ consent: e.target.value || null })}>
            <option value="">Any consent</option>
            <option value="granted">Opted in</option>
            <option value="declined">Declined</option>
            <option value="none">Not asked</option>
          </Select>
          <div className="ml-auto flex h-9 items-center gap-4 pl-2">
            <Checkbox label="Leads only" checked={filters.leadsOnly} onChange={(e) => setFilter({ leads: e.target.checked ? '1' : null })} />
            <Checkbox label="Include tests" checked={filters.includeTest} onChange={(e) => setFilter({ test: e.target.checked ? '1' : null })} />
          </div>
        </div>

        <Card>
          {contacts.isLoading ? (
            <SkeletonRows rows={8} />
          ) : contacts.error ? (
            <ErrorBanner error={contacts.error} className="m-4" onRetry={() => void contacts.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Users className="size-5" />}
              title={anyFilter ? 'No contacts match these filters' : 'No leads yet'}
              description={
                anyFilter
                  ? 'Try clearing a filter.'
                  : 'When visitors share their details with your assistant they appear here. Test the flow in the bot playground (tick “Include tests” to see those).'
              }
              action={
                anyFilter ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setSearchText('');
                      navigate('/contacts', { replace: true });
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <TH>Name</TH>
                    <TH>Email</TH>
                    <TH>Phone</TH>
                    <TH>Tier</TH>
                    <TH className="text-right">Score</TH>
                    <TH>Qualification</TH>
                    <TH>Stage</TH>
                    <TH>Source</TH>
                    <TH>Tags</TH>
                    <TH>Last activity</TH>
                  </tr>
                </thead>
                <tbody className={contacts.isPlaceholderData ? 'opacity-60' : ''}>
                  {items.map((c) => (
                    <ContactRow key={c.id} contact={c} />
                  ))}
                </tbody>
              </Table>
              <div className="flex items-center justify-between px-4 py-2.5 text-body-sm text-muted">
                <span className="tabular-nums">
                  {from}–{to} of {total.toLocaleString()}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ChevronLeft className="size-4" />}
                    disabled={filters.offset === 0}
                    onClick={() => navigate(withQuery(route, { offset: String(Math.max(0, filters.offset - PAGE_SIZE)) }), { replace: true })}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={filters.offset + PAGE_SIZE >= total}
                    onClick={() => navigate(withQuery(route, { offset: String(filters.offset + PAGE_SIZE) }), { replace: true })}
                  >
                    Next <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
      <CreateContactModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function ContactRow({ contact: c }: { contact: Contact }) {
  const name = c.name || c.email || c.phone || 'Anonymous visitor';
  const dash = <span className="text-muted">—</span>;
  return (
    <tr className="transition-colors hover:bg-surface-2/60">
      <TD>
        <div className="flex items-center gap-2.5">
          <PersonAvatar name={c.name || c.email || c.phone} />
          <div className="min-w-0">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <Link to={`/contacts/${c.id}`} className="font-semibold text-fg hover:text-accent-text">
                {name}
              </Link>
              {c.isTest && <Badge tone="blue">Test</Badge>}
              {c.hasPendingMerge && <Badge tone="amber">Possible duplicate</Badge>}
            </span>
            {c.company && <p className="text-caption text-muted">{c.company}</p>}
          </div>
        </div>
      </TD>
      <TD className="max-w-48 truncate text-fg-2">{c.email ?? dash}</TD>
      <TD className="whitespace-nowrap text-fg-2 tabular-nums">{c.phone ?? dash}</TD>
      <TD>
        <TierBadge tier={c.leadTier} />
      </TD>
      <TD className="text-right">
        <span className="inline-flex items-center gap-2">
          <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, c.leadScore))}%` }} />
          </span>
          <span className="min-w-6 font-semibold text-fg tabular-nums">{c.leadScore}</span>
        </span>
      </TD>
      <TD>
        <QualificationBadge status={c.qualificationStatus} />
      </TD>
      <TD className="text-fg-2">{c.lifecycleStage}</TD>
      <TD className="max-w-36 truncate text-fg-2" title={c.firstTouch?.utmCampaign ?? undefined}>
        {c.firstTouch?.utmSource ?? c.sourceChannel ?? dash}
      </TD>
      <TD>
        <div className="flex max-w-56 flex-wrap gap-1">
          {c.tags.slice(0, 3).map((t) => (
            <TagChip key={t.id} name={t.name} color={t.color} />
          ))}
          {c.tags.length > 3 && <span className="text-caption text-muted">+{c.tags.length - 3}</span>}
        </div>
      </TD>
      <TD className="whitespace-nowrap text-muted">{timeAgo(c.lastActivityAt ?? c.createdAt)}</TD>
    </tr>
  );
}

function CreateContactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const empty = { firstName: '', lastName: '', email: '', phone: '', company: '' };
  const [form, setForm] = useState(empty);
  // Mistakes show once they try to add the contact, then update as they type.
  const [tried, setTried] = useState(false);
  const create = useAction(
    (body: typeof empty) =>
      post<Contact>(
        '/v1/contacts',
        Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v.trim() || null])),
      ),
    {
      invalidate: [['contacts']],
      success: 'Contact added',
      errorToast: false,
      onSuccess: (c) => {
        setForm(empty);
        setTried(false);
        onClose();
        navigate(`/contacts/${c.id}`);
      },
    },
  );
  const local = {
    firstName: [form.firstName, form.lastName, form.email, form.phone].some((v) => v.trim()) ? null : 'Add a name, email or phone',
    email: form.email.trim() && !isEmail(form.email) ? 'Enter a valid email address' : null,
  };
  const server = fieldErrors(create.error);
  const errorOf = (k: keyof typeof empty) => (tried ? (local as Record<string, string | null>)[k] : null) || server[k] || null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (local.firstName || local.email) return;
    create.mutate(form);
  };
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => {
    if (create.error) create.reset(); // a server error goes once they change something
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add contact"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-contact" variant="primary" loading={create.isPending}>
            Add contact
          </Button>
        </>
      }
    >
      <form id="create-contact" className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
        {create.error && !Object.keys(server).length ? <ErrorBanner error={create.error} className="sm:col-span-2" /> : null}
        <Field label="First name" error={errorOf('firstName')}>
          <Input value={form.firstName} onChange={set('firstName')} />
        </Field>
        <Field label="Last name" error={errorOf('lastName')}>
          <Input value={form.lastName} onChange={set('lastName')} />
        </Field>
        <Field label="Email" error={errorOf('email')}>
          <Input type="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Phone" hint="Include the country code for numbers outside your default country." error={errorOf('phone')}>
          <Input type="tel" value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label="Company" className="col-span-2" error={errorOf('company')}>
          <Input value={form.company} onChange={set('company')} />
        </Field>
      </form>
    </Modal>
  );
}
