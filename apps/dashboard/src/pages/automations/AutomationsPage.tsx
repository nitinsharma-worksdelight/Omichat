import { useQuery } from '@tanstack/react-query';
import { FlaskConical, KeyRound, ListTree, Pencil, Plus, Tag as TagIcon, Trash2, Webhook as WebhookIcon, Workflow as WorkflowIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/feedback-context';
import { Drawer, MenuItem, Modal, Popover } from '../../components/overlay';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ChipsInput,
  CodeBlock,
  CopyButton,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  NumberInput,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  Tabs,
  TD,
  Textarea,
  TH,
  Toggle,
} from '../../components/ui';
import { ApiError, del, get, patch, post } from '../../lib/api';
import { formatDateTime, humanize, pretty, slugify, timeAgo } from '../../lib/format';
import { finalizeKey } from '../../lib/validate';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useCustomFields, useTags, useWorkflows } from '../../lib/queries';
import { navigate, useRoute, withQuery } from '../../lib/router';
import {
  CUSTOM_FIELD_TYPES,
  EVENT_TYPES,
  type CustomFieldDef,
  type CustomFieldType,
  type Tag,
  type Webhook,
  type WebhookDelivery,
  type Workflow,
  type WorkflowInputField,
  type WorkflowTestResult,
} from '../../lib/types';

type TabId = 'webhooks' | 'workflows' | 'tags' | 'fields';

export function AutomationsPage() {
  const route = useRoute();
  const { role } = useAuth();
  const isAdmin = roleAtLeast(role, 'admin');
  const param = route.query.get('tab') as TabId | null;
  const tab: TabId = param && ['webhooks', 'workflows', 'tags', 'fields'].includes(param) ? param : 'webhooks';
  return (
    <div>
      <PageHeader title="Automations" description="Send events to n8n or any webhook, let the assistant run workflows, and organise contacts with tags and fields.">
        <Tabs<TabId>
          className="px-6"
          ariaLabel="Automation sections"
          value={tab}
          onChange={(id) => navigate(withQuery(route, { tab: id }), { replace: true })}
          tabs={[
            { id: 'webhooks', label: 'Webhooks' },
            { id: 'workflows', label: 'Workflows (n8n)' },
            { id: 'tags', label: 'Tags' },
            { id: 'fields', label: 'Custom fields' },
          ]}
        />
      </PageHeader>
      <div className="px-4 sm:px-8 py-6">
        {!isAdmin && (tab === 'webhooks' || tab === 'workflows') ? (
          <Card>
            <EmptyState title="Admins only" description="Ask an admin of this organization to manage webhooks and workflows." />
          </Card>
        ) : tab === 'webhooks' ? (
          <WebhooksTab />
        ) : tab === 'workflows' ? (
          <WorkflowsTab />
        ) : tab === 'tags' ? (
          <TagsTab canCreate={roleAtLeast(role, 'agent')} canDelete={isAdmin} />
        ) : (
          <FieldsTab isAdmin={isAdmin} />
        )}
      </div>
    </div>
  );
}

function SectionHeader({ title, description, action }: { title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-body font-semibold text-fg">{title}</h2>
        <p className="mt-0.5 max-w-2xl text-body-sm text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

function SecretModal({ title, secret, onClose, children }: { title: string; secret: string; onClose: () => void; children?: ReactNode }) {
  return (
    <Modal open onClose={onClose} title={title} size="lg" footer={<Button variant="primary" onClick={onClose}>I've saved it</Button>}>
      <div className="space-y-4">
        <p className="rounded-md bg-warning-soft px-3 py-2 text-body-sm text-warning-text">
          Copy this secret now — it's shown only once. If you lose it, delete and recreate the endpoint.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-body-sm text-fg">{secret}</code>
          <CopyButton text={secret} />
        </div>
        {children}
      </div>
    </Modal>
  );
}

const SIGNATURE_HELP = `// x-omni-signature: t=<unix seconds>,v1=<hex>
// v1 = HMAC-SHA256(secret, "<t>.<raw request body>")
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', SECRET).update(\`\${t}.\${rawBody}\`).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300;`;

function SignatureHelp() {
  return (
    <div className="space-y-2 text-body-sm text-fg-2">
      <p>
        Every request is a <code className="font-mono text-caption">POST</code> with the headers <code className="font-mono text-caption">x-omni-event</code>,{' '}
        <code className="font-mono text-caption">x-omni-delivery</code> and <code className="font-mono text-caption">x-omni-signature</code>. Verify the signature before trusting the payload:
      </p>
      <CodeBlock>{SIGNATURE_HELP}</CodeBlock>
      <p className="text-caption text-muted">Non-2xx responses are retried with exponential backoff (up to 6 attempts).</p>
    </div>
  );
}

// ---------- Webhooks ----------

function WebhooksTab() {
  const confirm = useConfirm();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => get<Webhook[]>('/v1/webhooks') });
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<Webhook | null>(null);
  const toggle = useAction((h: Webhook) => patch(`/v1/webhooks/${h.id}`, { name: h.name, url: h.url, eventTypes: h.eventTypes, isActive: !h.isActive }), { invalidate: [['webhooks']] });
  const remove = useAction((id: string) => del(`/v1/webhooks/${id}`), { invalidate: [['webhooks']], success: 'Webhook deleted' });
  return (
    <div>
      <SectionHeader
        title="Webhooks"
        description="Push events (new leads, bookings, handoffs…) to n8n, Zapier or your own backend in real time."
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add endpoint
          </Button>
        }
      />
      <Card>
        {hooks.isLoading ? (
          <SkeletonRows rows={3} />
        ) : hooks.error ? (
          <ErrorBanner error={hooks.error} className="m-4" />
        ) : !hooks.data?.length ? (
          <EmptyState icon={<WebhookIcon className="size-5" />} title="No webhook endpoints" description="Add an n8n Webhook node URL to receive lead.captured, appointment.booked and other events." />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Endpoint</TH>
                <TH>Events</TH>
                <TH>Active</TH>
                <TH>Created</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </thead>
            <tbody>
              {hooks.data.map((h) => (
                <tr key={h.id}>
                  <TD className="max-w-md">
                    <p className="font-medium text-fg">{h.name}</p>
                    <p className="truncate font-mono text-caption text-muted">{h.url}</p>
                  </TD>
                  <TD>
                    {h.eventTypes.includes('*') ? (
                      <Badge tone="indigo">All events</Badge>
                    ) : (
                      <span className="text-body-sm text-fg-2" title={h.eventTypes.join(', ')}>
                        {h.eventTypes.length} event{h.eventTypes.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <Toggle size="sm" checked={h.isActive} onChange={() => toggle.mutate(h)} id={`hook-active-${h.id}`} ariaLabel={`${h.name} active`} />
                  </TD>
                  <TD className="whitespace-nowrap text-muted">{timeAgo(h.createdAt)}</TD>
                  <TD className="text-right whitespace-nowrap">
                    <Button size="xs" variant="ghost" icon={<ListTree className="size-3" />} onClick={() => setDeliveriesFor(h)}>
                      Deliveries
                    </Button>
                    <IconButton label={`Edit ${h.name}`} size="sm" onClick={() => setEditing(h)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <IconButton
                      label={`Delete ${h.name}`}
                      size="sm"
                      onClick={async () => {
                        if (await confirm({ title: `Delete “${h.name}”?`, message: 'Events stop being sent to this URL.', confirmLabel: 'Delete', danger: true })) remove.mutate(h.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && (
        <WebhookDialog
          hook={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onCreated={(s) => {
            setEditing(null);
            setSecret(s);
          }}
        />
      )}
      {secret && (
        <SecretModal title="Webhook signing secret" secret={secret} onClose={() => setSecret(null)}>
          <SignatureHelp />
        </SecretModal>
      )}
      <DeliveriesDrawer hook={deliveriesFor} onClose={() => setDeliveriesFor(null)} />
    </div>
  );
}

function WebhookDialog({ hook, onClose, onCreated }: { hook?: Webhook; onClose: () => void; onCreated: (secret: string) => void }) {
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [all, setAll] = useState(hook ? hook.eventTypes.includes('*') : true);
  const [types, setTypes] = useState<string[]>(hook && !hook.eventTypes.includes('*') ? hook.eventTypes : []);
  const [isActive, setIsActive] = useState(hook?.isActive ?? true);
  const body = { name: name.trim(), url: url.trim(), eventTypes: all ? ['*'] : types, isActive };
  const save = useAction(() => (hook ? patch<Webhook>(`/v1/webhooks/${hook.id}`, body) : post<Webhook>('/v1/webhooks', body)), {
    invalidate: [['webhooks']],
    errorToast: false,
    success: hook ? 'Webhook updated' : 'Webhook created',
    onSuccess: (res) => (hook ? onClose() : onCreated(res.secret ?? '')),
  });
  const groups = new Map<string, string[]>();
  for (const t of EVENT_TYPES) {
    const g = t.split('.')[0]!;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={hook ? 'Edit webhook' : 'Add webhook endpoint'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim() || !url.trim() || (!all && types.length === 0)} onClick={() => save.mutate()}>
            {hook ? 'Save' : 'Create endpoint'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error ? <ErrorBanner error={save.error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={name} maxLength={120} placeholder="n8n – new leads" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="URL" required hint="Must be a public https URL.">
            <Input type="url" value={url} placeholder="https://n8n.example.com/webhook/…" onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </div>
        <fieldset className="space-y-3">
          <legend className="mb-1 text-body-sm font-medium text-fg-2">Events</legend>
          <Checkbox label="All events" description="Including event types added in the future." checked={all} onChange={(e) => setAll(e.target.checked)} />
          {!all && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border p-3 sm:grid-cols-3">
              {[...groups.entries()].map(([group, list]) => (
                <div key={group} className="space-y-1.5">
                  <p className="text-caption font-medium text-muted uppercase">{group}</p>
                  {list.map((t) => (
                    <Checkbox
                      key={t}
                      label={<code className="font-mono text-caption">{t}</code>}
                      checked={types.includes(t)}
                      onChange={(e) => setTypes((s) => (e.target.checked ? [...s, t] : s.filter((x) => x !== t)))}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </fieldset>
        {hook && <Toggle label="Active" checked={isActive} onChange={setIsActive} />}
        {!hook && <SignatureHelp />}
      </div>
    </Modal>
  );
}

function DeliveriesDrawer({ hook, onClose }: { hook: Webhook | null; onClose: () => void }) {
  const deliveries = useQuery({
    queryKey: ['deliveries', hook?.id],
    queryFn: () => get<WebhookDelivery[]>(`/v1/webhooks/${hook!.id}/deliveries`),
    enabled: Boolean(hook),
    refetchInterval: hook ? 10_000 : false,
  });
  return (
    <Drawer open={Boolean(hook)} onClose={onClose} title={hook ? `Deliveries · ${hook.name}` : 'Deliveries'} description="The last 100 attempts to deliver events to this endpoint." width="max-w-3xl">
      {deliveries.isLoading ? (
        <SkeletonRows rows={5} className="p-0" />
      ) : deliveries.error ? (
        <ErrorBanner error={deliveries.error} />
      ) : !deliveries.data?.length ? (
        <EmptyState title="No deliveries yet" description="Deliveries appear here as soon as a matching event happens." />
      ) : (
        <Table>
          <thead>
            <tr>
              <TH>Event</TH>
              <TH>Status</TH>
              <TH>Attempts</TH>
              <TH>Response</TH>
              <TH>Time</TH>
            </tr>
          </thead>
          <tbody>
            {deliveries.data.map((d) => (
              <tr key={d.id}>
                <TD>
                  <code className="font-mono text-caption">{d.eventType}</code>
                </TD>
                <TD>
                  <Badge tone={d.status === 'success' ? 'green' : d.status === 'failed' ? 'red' : 'amber'}>{d.status}</Badge>
                </TD>
                <TD className="tabular-nums">{d.attemptCount}</TD>
                <TD className="max-w-64">
                  {d.responseStatus !== null && <span className="font-mono text-caption">HTTP {d.responseStatus}</span>}
                  {d.lastError && <p className="truncate text-caption text-danger-text" title={d.lastError}>{d.lastError}</p>}
                  {d.responseBody && <p className="truncate text-caption text-muted" title={d.responseBody}>{d.responseBody}</p>}
                </TD>
                <TD className="whitespace-nowrap text-caption text-muted">{formatDateTime(d.deliveredAt ?? d.createdAt)}</TD>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Drawer>
  );
}

// ---------- Workflows ----------

function WorkflowsTab() {
  const confirm = useConfirm();
  const workflows = useWorkflows();
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [testing, setTesting] = useState<Workflow | null>(null);
  const remove = useAction((id: string) => del(`/v1/workflows/${id}`), { invalidate: [['workflows']], success: 'Workflow deleted' });
  return (
    <div>
      <SectionHeader
        title="Workflows"
        description="n8n workflows the assistant can run mid-conversation — e.g. create a CRM deal or send a quote. Enable them per bot on the bot's Actions tab."
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add workflow
          </Button>
        }
      />
      <Card>
        {workflows.isLoading ? (
          <SkeletonRows rows={3} />
        ) : workflows.error ? (
          <ErrorBanner error={workflows.error} className="m-4" />
        ) : !workflows.data?.length ? (
          <EmptyState icon={<WorkflowIcon className="size-5" />} title="No workflows" description="Point the assistant at an n8n Webhook trigger and describe when to use it." />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Workflow</TH>
                <TH>Mode</TH>
                <TH>Inputs</TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </thead>
            <tbody>
              {workflows.data.map((w) => (
                <tr key={w.id}>
                  <TD className="max-w-md">
                    <p className="font-medium text-fg">
                      {w.name} <code className="ml-1 font-mono text-caption font-normal text-muted">{w.key}</code>
                    </p>
                    <p className="line-clamp-2 text-caption text-muted">{w.description}</p>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone="slate">{w.mode === 'request_response' ? 'Waits for response' : 'Fire and forget'}</Badge>
                      {w.identifiedOnly && <Badge tone="blue">Identified only</Badge>}
                      {w.askFirst && <Badge tone="amber">Asks the team first</Badge>}
                    </div>
                  </TD>
                  <TD className="text-body-sm text-fg-2">{w.inputFields.length ? w.inputFields.map((f) => f.name).join(', ') : '—'}</TD>
                  <TD>
                    <Badge tone={w.isActive ? 'green' : 'slate'}>{w.isActive ? 'Active' : 'Inactive'}</Badge>
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    <Button size="xs" variant="ghost" icon={<FlaskConical className="size-3" />} onClick={() => setTesting(w)}>
                      Test
                    </Button>
                    <IconButton label={`Edit ${w.name}`} size="sm" onClick={() => setEditing(w)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <IconButton
                      label={`Delete ${w.name}`}
                      size="sm"
                      onClick={async () => {
                        if (await confirm({ title: `Delete “${w.name}”?`, message: 'Bots that use this workflow can no longer trigger it.', confirmLabel: 'Delete', danger: true })) remove.mutate(w.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && (
        <WorkflowDialog
          workflow={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onCreated={(s) => {
            setEditing(null);
            setSecret(s);
          }}
        />
      )}
      {secret && (
        <SecretModal title="Workflow signing secret" secret={secret} onClose={() => setSecret(null)}>
          <p className="text-body-sm text-fg-2">
            Calls to your workflow carry an <code className="font-mono text-caption">x-omni-workflow</code> header with the key and an{' '}
            <code className="font-mono text-caption">x-omni-signature</code> header signed with this secret (same format as webhooks).
          </p>
          <SignatureHelp />
        </SecretModal>
      )}
      {testing && <WorkflowTestDialog workflow={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

const emptyField = (): WorkflowInputField => ({ name: '', type: 'string', description: '', required: false, source: 'chat' });

const SOURCES: Array<{ value: NonNullable<WorkflowInputField['source']>; label: string }> = [
  { value: 'chat', label: 'The chat (the assistant fills it)' },
  { value: 'contact.email', label: 'Their email on record' },
  { value: 'contact.phone', label: 'Their phone on record' },
  { value: 'contact.name', label: 'Their name on record' },
  { value: 'contact.id', label: 'Their contact ID' },
];

/** An input the assistant fills from the chat whose name suggests it identifies someone. */
const looksLikeIdentity = (f: WorkflowInputField) => (f.source ?? 'chat') === 'chat' && /mail|phone|mobile|account|customer|user/i.test(f.name);

function WorkflowDialog({ workflow, onClose, onCreated }: { workflow?: Workflow; onClose: () => void; onCreated: (secret: string) => void }) {
  const [form, setForm] = useState(() => ({
    key: workflow?.key ?? '',
    name: workflow?.name ?? '',
    description: workflow?.description ?? '',
    url: workflow?.url ?? '',
    mode: workflow?.mode ?? ('fire_and_forget' as Workflow['mode']),
    timeoutMs: workflow?.timeoutMs ?? 10_000,
    identifiedOnly: workflow?.identifiedOnly ?? false,
    askFirst: workflow?.askFirst ?? false,
    isActive: workflow?.isActive ?? true,
    inputFields: (workflow?.inputFields.map((f) => ({ ...f, source: f.source ?? 'chat' })) ?? []) as WorkflowInputField[],
  }));
  const identityFromChat = form.mode === 'request_response' && form.inputFields.some(looksLikeIdentity);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setInput = (i: number, p: Partial<WorkflowInputField>) => set('inputFields', form.inputFields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  // PATCH sends every field: the server fills omitted ones with defaults.
  const { key, ...rest } = form;
  const save = useAction(() => (workflow ? patch<Workflow>(`/v1/workflows/${workflow.id}`, rest) : post<Workflow>('/v1/workflows', { key: finalizeKey(key), ...rest })), {
    invalidate: [['workflows']],
    errorToast: false,
    success: workflow ? 'Workflow updated' : 'Workflow created',
    onSuccess: (res) => (workflow ? onClose() : onCreated(res.secret ?? '')),
  });
  const descTooShort = form.description.trim().length < 10;
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={workflow ? `Edit ${workflow.name}` : 'Add workflow'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!finalizeKey(form.key) || !form.name.trim() || !form.url.trim() || descTooShort} onClick={() => save.mutate()}>
            {workflow ? 'Save' : 'Create workflow'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error ? <ErrorBanner error={save.error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={form.name} maxLength={120} placeholder="Create CRM deal" onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Key" required hint={workflow ? 'The key cannot be changed.' : <KeyHint value={form.key} fallback="Lowercase letters, digits and underscores." />}>
            <Input
              className="font-mono text-body-sm"
              value={form.key}
              disabled={Boolean(workflow)}
              maxLength={64}
              placeholder="create_deal"
              onChange={(e) => set('key', slugify(e.target.value))}
              onBlur={() => set('key', finalizeKey(form.key))}
            />
          </Field>
        </div>
        <Field label="When should the assistant use it?" required hint="The assistant reads this to decide when to call the workflow (at least 10 characters)." error={form.description && descTooShort ? 'Describe it in at least 10 characters.' : null}>
          <Textarea rows={3} maxLength={1000} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Create a deal in the CRM once a lead is qualified and has given an email address." />
        </Field>
        <Field label="Webhook URL" required hint="Your n8n Webhook trigger URL.">
          <Input type="url" value={form.url} placeholder="https://n8n.example.com/webhook/…" onChange={(e) => set('url', e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Mode" className="col-span-2">
            <Select value={form.mode} onChange={(e) => set('mode', e.target.value as Workflow['mode'])}>
              <option value="fire_and_forget">Fire and forget — queue it and continue</option>
              <option value="request_response">Wait for the response — the assistant uses the result</option>
            </Select>
          </Field>
          <Field label="Timeout (ms)" hint="1,000–30,000">
            <NumberInput min={1000} max={30000} step={500} value={form.timeoutMs} onChange={(v) => set('timeoutMs', Math.round(v ?? 10000))} />
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-body-sm font-medium text-fg-2">Inputs the assistant should send</legend>
          {form.inputFields.length === 0 && <p className="text-caption text-muted">No inputs — the workflow receives the contact and conversation only.</p>}
          {form.inputFields.map((f, i) => (
            <div key={i} className="grid grid-cols-[140px_100px_1fr_170px_auto_auto] items-center gap-2">
              <Input aria-label={`Input ${i + 1} name`} className="font-mono text-body-sm" placeholder="name" value={f.name} maxLength={64} onChange={(e) => setInput(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })} />
              <Select
                aria-label={`Input ${i + 1} type`}
                value={f.type}
                disabled={(f.source ?? 'chat') !== 'chat'}
                onChange={(e) => setInput(i, { type: e.target.value as WorkflowInputField['type'] })}
              >
                <option value="string">Text</option>
                <option value="number">Number</option>
                <option value="boolean">Yes/no</option>
              </Select>
              <Input aria-label={`Input ${i + 1} description`} placeholder="What to put here" value={f.description} maxLength={300} onChange={(e) => setInput(i, { description: e.target.value })} />
              <Select
                aria-label={`Input ${i + 1} value from`}
                value={f.source ?? 'chat'}
                onChange={(e) => {
                  const source = e.target.value as NonNullable<WorkflowInputField['source']>;
                  setInput(i, source === 'chat' ? { source } : { source, type: 'string' });
                }}
              >
                {SOURCES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Checkbox label="Required" checked={f.required} onChange={(e) => setInput(i, { required: e.target.checked })} />
              <IconButton label={`Remove input ${i + 1}`} size="sm" onClick={() => set('inputFields', form.inputFields.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" icon={<Plus className="size-3.5" />} disabled={form.inputFields.length >= 20} onClick={() => set('inputFields', [...form.inputFields, emptyField()])}>
            Add input
          </Button>
          <p className="text-caption text-muted">
            Values from the chat are whatever the customer typed. Values on record come from their contact, and the assistant can't send others instead. A web-chat
            visitor's record still holds only what they told the assistant, so neither proves who is asking: that takes “Identified customers only”.
          </p>
          {identityFromChat && !form.identifiedOnly && (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-body-sm text-warning-text">
              This workflow sends its answer back to the assistant and takes an email, phone or account from the chat. Anyone could type someone else's. If it returns personal
              data, take those values from the record and turn on “Identified customers only”.
            </p>
          )}
        </fieldset>
        <Toggle
          label="Identified customers only"
          description="Runs only for customers your own systems identify (the chat API). Web-chat visitors are offered your team instead."
          checked={form.identifiedOnly}
          onChange={(v) => set('identifiedOnly', v)}
        />
        <Toggle
          label="Ask the team first"
          description={
            form.identifiedOnly
              ? 'Each call waits for your team’s approval (under Approvals). Web-chat visitors can use it too: the person approving checks who is asking.'
              : 'Each call waits for your team’s approval (under Approvals), and the customer is told a team member will confirm.'
          }
          checked={form.askFirst}
          onChange={(v) => set('askFirst', v)}
        />
        <Toggle label="Active" checked={form.isActive} onChange={(v) => set('isActive', v)} />
      </div>
    </Modal>
  );
}

function WorkflowTestDialog({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries(workflow.inputFields.map((f) => [f.name, f.type === 'boolean' ? 'true' : ''])));
  const test = useAction(
    () => {
      const typed: Record<string, unknown> = {};
      for (const f of workflow.inputFields) {
        const raw = inputs[f.name] ?? '';
        if (raw === '') continue;
        typed[f.name] = f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw;
      }
      return post<WorkflowTestResult>(`/v1/workflows/${encodeURIComponent(workflow.key)}/test`, { inputs: typed });
    },
    { errorToast: false },
  );
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={`Test ${workflow.name}`}
      description="Runs the workflow now with sample inputs. No contact or conversation is attached."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" icon={<FlaskConical className="size-3.5" />} loading={test.isPending} onClick={() => test.mutate()}>
            Run test
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {workflow.inputFields.length === 0 ? (
          <p className="text-body-sm text-muted">This workflow has no inputs.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {workflow.inputFields.map((f) => (
              <Field key={f.name} label={<code className="font-mono text-caption">{f.name}</code>} hint={f.description || f.type} required={f.required}>
                {f.type === 'boolean' ? (
                  <Select value={inputs[f.name] ?? 'true'} onChange={(e) => setInputs((s) => ({ ...s, [f.name]: e.target.value }))}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Select>
                ) : (
                  <Input type={f.type === 'number' ? 'number' : 'text'} value={inputs[f.name] ?? ''} onChange={(e) => setInputs((s) => ({ ...s, [f.name]: e.target.value }))} />
                )}
              </Field>
            ))}
          </div>
        )}
        {test.error ? <ErrorBanner error={test.error} /> : null}
        {test.data && (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-body-sm">
              Result: <Badge tone={test.data.ok ? 'green' : 'red'}>{test.data.ok ? 'OK' : 'Failed'}</Badge>
              {test.data.queued && <span className="text-caption text-muted">Queued (fire and forget) — check your n8n executions.</span>}
              {test.data.status !== undefined && <span className="font-mono text-caption text-muted">HTTP {test.data.status}</span>}
            </p>
            {test.data.error && <p className="text-body-sm text-danger-text">{test.data.error}</p>}
            {test.data.response !== undefined && <CodeBlock className="max-h-64 overflow-auto">{pretty(test.data.response)}</CodeBlock>}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- Tags ----------

const TAG_COLORS = ['#64748b', '#4f46e5', '#0ea5e9', '#16a34a', '#d97706', '#dc2626', '#db2777', '#7c3aed'];

function TagsTab({ canCreate, canDelete }: { canCreate: boolean; canDelete: boolean }) {
  const tags = useTags();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [color, setColor] = useState(TAG_COLORS[1]!);
  const create = useAction(() => post<Tag>('/v1/tags', { name: name.trim(), color }), { invalidate: [['tags']], success: 'Tag created', onSuccess: () => setName('') });
  const remove = useAction((id: string) => del(`/v1/tags/${id}`), { invalidate: [['tags'], ['contacts']], success: 'Tag deleted' });
  return (
    <div>
      <SectionHeader title="Tags" description="Labels for contacts. The assistant can apply them too (limit which ones on each bot's Actions tab)." />
      {canCreate && (
        <Card className="mb-4 p-4">
          <form
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <Field label="New tag" className="w-64">
              <Input value={name} maxLength={60} placeholder="vip" onChange={(e) => setName(e.target.value)} />
            </Field>
            <fieldset>
              <legend className="mb-1.5 text-body-sm font-medium text-fg-2">Colour</legend>
              <div className="flex h-9 items-center gap-1.5">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Colour ${c}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                    className={`size-6 rounded-full border-2 ${color === c ? 'border-fg' : 'border-transparent'}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </fieldset>
            <Button type="submit" icon={<Plus className="size-4" />} loading={create.isPending} disabled={!name.trim()}>
              Add tag
            </Button>
          </form>
        </Card>
      )}
      <Card>
        {tags.isLoading ? (
          <SkeletonRows rows={3} />
        ) : tags.error ? (
          <ErrorBanner error={tags.error} className="m-4" />
        ) : !tags.data?.length ? (
          <EmptyState icon={<TagIcon className="size-5" />} title="No tags yet" description="Create tags like “vip”, “price-shopper” or “emergency” to segment leads." />
        ) : (
          <ul className="divide-y divide-border">
            {tags.data.map((t) => (
              <li key={t.id} className="flex items-center justify-between px-4 py-2.5">
                <span className="flex items-center gap-2.5 text-body-sm text-fg">
                  <span className="size-3 rounded-full" style={{ background: t.color }} aria-hidden />
                  {t.name}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-caption text-muted">{t.createdAt ? `created ${timeAgo(t.createdAt)}` : ''}</span>
                  {canDelete && (
                    <IconButton
                      label={`Delete tag ${t.name}`}
                      size="sm"
                      onClick={async () => {
                        if (await confirm({ title: `Delete tag “${t.name}”?`, message: 'It is removed from every contact.', confirmLabel: 'Delete', danger: true })) remove.mutate(t.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------- Custom fields ----------

/** Ready-made business details, each with a description telling the assistant when to fill it. */
const FIELD_TEMPLATES: Array<Pick<CustomFieldDef, 'key' | 'label' | 'type' | 'options' | 'description'>> = [
  {
    key: 'industry',
    label: 'Industry',
    type: 'select',
    options: ['Healthcare', 'Real estate', 'Retail', 'Professional services', 'Hospitality', 'Construction', 'Technology', 'Education', 'Finance', 'Other'],
    description: 'The industry their business is in, if they mention it.',
  },
  {
    key: 'company_size',
    label: 'Company size',
    type: 'select',
    options: ['Just me', '2–10', '11–50', '51–200', '201–1,000', 'Over 1,000'],
    description: 'How many people work at their company, if they mention it.',
  },
  { key: 'website', label: 'Website', type: 'url', options: [], description: 'Their business website, if they share it.' },
  { key: 'budget', label: 'Budget', type: 'text', options: [], description: 'The budget they mention for what they want, in their own words (e.g. "$5–10k").' },
  { key: 'job_title', label: 'Job title', type: 'text', options: [], description: 'Their role or job title, if they mention it.' },
];

function FieldsTab({ isAdmin }: { isAdmin: boolean }) {
  const fields = useCustomFields();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<CustomFieldDef | 'new' | null>(null);
  const remove = useAction((id: string) => del(`/v1/custom-fields/${id}`), { invalidate: [['custom-fields']], success: 'Field deleted' });
  const addTemplate = useAction((tpl: (typeof FIELD_TEMPLATES)[number]) => post<CustomFieldDef>('/v1/custom-fields', { ...tpl, aiWritable: true }), {
    invalidate: [['custom-fields']],
    success: 'Field added',
  });
  const missingTemplates = FIELD_TEMPLATES.filter((tpl) => !(fields.data ?? []).some((f) => f.key === tpl.key));
  return (
    <div>
      <SectionHeader
        title="Custom fields"
        description="Extra details to collect about contacts, e.g. service of interest or budget. Use them in lead capture and qualification."
        action={
          isAdmin && (
            <div className="flex gap-2">
              {fields.data && missingTemplates.length > 0 && (
                <Popover
                  label="Business-detail templates"
                  trigger={({ toggle, open, id }) => (
                    <Button icon={<ListTree className="size-4" />} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
                      Add from template
                    </Button>
                  )}
                >
                  {(close) =>
                    missingTemplates.map((tpl) => (
                      <MenuItem
                        key={tpl.key}
                        onClick={() => {
                          close();
                          addTemplate.mutate(tpl);
                        }}
                      >
                        {tpl.label}
                      </MenuItem>
                    ))
                  }
                </Popover>
              )}
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                Add field
              </Button>
            </div>
          )
        }
      />
      <Card>
        {fields.isLoading ? (
          <SkeletonRows rows={3} />
        ) : fields.error ? (
          <ErrorBanner error={fields.error} className="m-4" />
        ) : !fields.data?.length ? (
          <EmptyState icon={<KeyRound className="size-5" />} title="No custom fields" description="Add fields for anything beyond name, email, phone and company." />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Field</TH>
                <TH>Type</TH>
                <TH>AI can write</TH>
                <TH>Description</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </thead>
            <tbody>
              {fields.data.map((f) => (
                <tr key={f.id}>
                  <TD>
                    <p className="font-medium text-fg">{f.label}</p>
                    <code className="font-mono text-caption text-muted">{f.key}</code>
                  </TD>
                  <TD>
                    <Badge tone="slate">{humanize(f.type)}</Badge>
                    {f.type === 'select' && <p className="mt-0.5 max-w-56 truncate text-caption text-muted">{f.options.join(', ')}</p>}
                  </TD>
                  <TD>{f.aiWritable ? <Badge tone="green">Yes</Badge> : <Badge tone="slate">Staff only</Badge>}</TD>
                  <TD className="max-w-sm text-body-sm text-fg-2">{f.description || '—'}</TD>
                  <TD className="text-right whitespace-nowrap">
                    {isAdmin && (
                      <>
                        <IconButton label={`Edit ${f.label}`} size="sm" onClick={() => setEditing(f)}>
                          <Pencil className="size-4" />
                        </IconButton>
                        <IconButton
                          label={`Delete ${f.label}`}
                          size="sm"
                          onClick={async () => {
                            if (await confirm({ title: `Delete “${f.label}”?`, message: 'Existing values stay on contacts but can no longer be edited. Bots that collect this field must be updated.', confirmLabel: 'Delete', danger: true }))
                              remove.mutate(f.id);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      </>
                    )}
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <FieldDialog field={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Under a key being typed: the key as it will be saved, when that differs from what's in the box. */
function KeyHint({ value, fallback }: { value: string; fallback: string }) {
  const saved = finalizeKey(value);
  return value && saved !== value ? (
    <>
      Saved as <span className="font-mono">{saved || '(empty)'}</span>
    </>
  ) : (
    <>{fallback}</>
  );
}

function FieldDialog({ field, onClose }: { field?: CustomFieldDef; onClose: () => void }) {
  const [form, setForm] = useState(() => ({
    key: field?.key ?? '',
    label: field?.label ?? '',
    type: field?.type ?? ('text' as CustomFieldType),
    options: field?.options ?? [],
    description: field?.description ?? '',
    aiWritable: field?.aiWritable ?? true,
  }));
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const { key, ...rest } = form;
  const body = { ...rest, options: form.type === 'select' ? form.options : [] };
  // PATCH sends every field: the server fills omitted ones with defaults.
  const save = useAction(() => (field ? patch<CustomFieldDef>(`/v1/custom-fields/${field.id}`, body) : post<CustomFieldDef>('/v1/custom-fields', { key: finalizeKey(key), ...body })), {
    invalidate: [['custom-fields']],
    errorToast: false,
    success: field ? 'Field updated' : 'Field created',
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={field ? `Edit ${field.label}` : 'Add custom field'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!finalizeKey(form.key) || !form.label.trim() || (form.type === 'select' && form.options.length === 0)} onClick={() => save.mutate()}>
            {field ? 'Save' : 'Create field'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error ? <ErrorBanner error={save.error} details={save.error instanceof ApiError && save.error.code === 'validation_error' ? save.error.details : undefined} title={save.error instanceof ApiError && save.error.code === 'validation_error' ? save.error.message : undefined} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Label" required>
            <Input
              value={form.label}
              maxLength={100}
              placeholder="Service of interest"
              onChange={(e) => {
                const label = e.target.value;
                // The key follows the label until someone types their own.
                setForm((f) => ({ ...f, label, key: field || (f.key && f.key !== finalizeKey(f.label)) ? f.key : finalizeKey(label) }));
              }}
            />
          </Field>
          <Field label="Key" required hint={field ? 'The key cannot be changed.' : <KeyHint value={form.key} fallback="Used by the AI and in exports." />}>
            <Input
              className="font-mono text-body-sm"
              value={form.key}
              disabled={Boolean(field)}
              maxLength={64}
              onChange={(e) => set('key', slugify(e.target.value))}
              onBlur={() => set('key', finalizeKey(form.key))}
            />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => set('type', e.target.value as CustomFieldType)}>
              {CUSTOM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {form.type === 'select' && (
          <Field label="Options" required>
            <ChipsInput value={form.options} onChange={(v) => set('options', v)} placeholder="Type an option and press Enter" />
          </Field>
        )}
        <Field label="Description" hint="Tells the assistant what this field means and when to fill it.">
          <Textarea rows={2} maxLength={500} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Toggle label="The AI can fill this field" description="Turn off for fields only your team should set." checked={form.aiWritable} onChange={(v) => set('aiWritable', v)} />
      </div>
    </Modal>
  );
}
