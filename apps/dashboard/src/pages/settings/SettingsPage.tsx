import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, KeyRound, MessageSquare, Pencil, Plus, RefreshCw, Save, Trash2, UserPlus } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/feedback-context';
import { Modal } from '../../components/overlay';
import {
  Badge,
  Button,
  Card,
  CardHeader,
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
import { API_URL, del, get, patch, post } from '../../lib/api';
import { formatDate, initialsOf, timeAgo } from '../../lib/format';
import { timezones } from '../../lib/hooks';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useBots, useChannels, useOrg } from '../../lib/queries';
import { navigate, useRoute, withQuery } from '../../lib/router';
import { API_KEY_SCOPES, type ApiKey, type Channel, type ChannelTheme, type CreatedApiKey, type Member, type Organization, type Role } from '../../lib/types';

type TabId = 'organization' | 'channels' | 'team' | 'api-keys';

export function SettingsPage() {
  const route = useRoute();
  const { role } = useAuth();
  const isAdmin = roleAtLeast(role, 'admin');
  const param = route.query.get('tab') as TabId | null;
  const tab: TabId = param && ['organization', 'channels', 'team', 'api-keys'].includes(param) ? param : 'organization';
  return (
    <div>
      <PageHeader title="Settings" description="Your organization, website chat, team and API access.">
        <Tabs<TabId>
          className="px-6"
          ariaLabel="Settings sections"
          value={tab}
          onChange={(id) => navigate(withQuery(route, { tab: id }), { replace: true })}
          tabs={[
            { id: 'organization', label: 'Organization' },
            { id: 'channels', label: 'Website chat' },
            { id: 'team', label: 'Team' },
            { id: 'api-keys', label: 'API keys' },
          ]}
        />
      </PageHeader>
      <div className="px-8 py-6">
        {tab === 'organization' && <OrganizationTab isAdmin={isAdmin} />}
        {tab === 'channels' && <ChannelsTab isAdmin={isAdmin} />}
        {tab === 'team' && <TeamTab isAdmin={isAdmin} />}
        {tab === 'api-keys' &&
          (isAdmin ? (
            <ApiKeysTab />
          ) : (
            <Card>
              <EmptyState title="Admins only" description="Ask an admin to create API keys." />
            </Card>
          ))}
      </div>
    </div>
  );
}

// ---------- Organization ----------

interface OrgForm {
  name: string;
  timezone: string;
  defaultCountry: string;
  currency: string;
  aiEnabled: boolean;
  monthlyAiBudgetUsd: number | null;
  notificationEmails: string[];
  lifecycleStages: string[];
}

function toOrgForm(o: Organization): OrgForm {
  return {
    name: o.name,
    timezone: o.timezone,
    defaultCountry: o.settings.defaultCountry,
    currency: o.settings.currency ?? 'USD',
    aiEnabled: o.aiEnabled,
    monthlyAiBudgetUsd: o.monthlyAiBudgetUsd,
    notificationEmails: [...o.settings.notificationEmails],
    lifecycleStages: [...o.settings.lifecycleStages],
  };
}

function OrganizationTab({ isAdmin }: { isAdmin: boolean }) {
  const org = useOrg();
  if (org.isLoading) return <SkeletonRows rows={6} />;
  if (org.error || !org.data) return <ErrorBanner error={org.error} onRetry={() => void org.refetch()} />;
  return <OrganizationForm key={org.data.id} org={org.data} isAdmin={isAdmin} />;
}

function OrganizationForm({ org, isAdmin }: { org: Organization; isAdmin: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState(() => toOrgForm(org));
  const base = useMemo(() => toOrgForm(org), [org]);
  const tzList = useMemo(() => timezones(), []);
  const currencies = useMemo(() => Intl.supportedValuesOf('currency'), []);
  const set = <K extends keyof OrgForm>(k: K, v: OrgForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const changed = (k: keyof OrgForm) => JSON.stringify(form[k]) !== JSON.stringify(base[k]);
  const dirty = (Object.keys(form) as Array<keyof OrgForm>).some(changed);

  const save = useAction(
    (override?: Partial<OrgForm>) => {
      const next = { ...form, ...override };
      const body: Record<string, unknown> = {};
      if (override) Object.assign(body, override);
      else {
        if (changed('name')) body.name = next.name.trim();
        if (changed('timezone')) body.timezone = next.timezone;
        if (changed('aiEnabled')) body.aiEnabled = next.aiEnabled;
        if (changed('monthlyAiBudgetUsd')) body.monthlyAiBudgetUsd = next.monthlyAiBudgetUsd;
        const settings: Record<string, unknown> = {};
        if (changed('notificationEmails')) settings.notificationEmails = next.notificationEmails;
        if (changed('lifecycleStages')) settings.lifecycleStages = next.lifecycleStages;
        if (changed('defaultCountry')) settings.defaultCountry = next.defaultCountry.trim().toUpperCase();
        if (changed('currency')) settings.currency = next.currency;
        if (Object.keys(settings).length) body.settings = settings;
      }
      return patch<Organization>('/v1/org', body);
    },
    {
      errorToast: false,
      success: 'Settings saved',
      onSuccess: (updated, override) => {
        qc.setQueryData(['org'], updated);
        void qc.invalidateQueries({ queryKey: ['me'] });
        // The kill switch saves on its own; keep any other unsaved edits.
        if (override) setForm((f) => ({ ...f, aiEnabled: updated.aiEnabled }));
        else setForm(toOrgForm(updated));
      },
    },
  );

  return (
    <div className="max-w-3xl space-y-6">
      <Card className={form.aiEnabled ? '' : 'border-warning/50'}>
        <div className="p-4">
          <Toggle
            label={form.aiEnabled ? 'AI replies are on' : 'AI replies are paused'}
            description="Kill switch: when off, no assistant replies anywhere — conversations wait for your team."
            checked={form.aiEnabled}
            disabled={!isAdmin || save.isPending}
            onChange={async (v) => {
              if (!v && !(await confirm({ title: 'Pause all AI replies?', message: 'Every assistant stops replying immediately until you turn this back on.', confirmLabel: 'Pause AI', danger: true }))) return;
              set('aiEnabled', v);
              save.mutate({ aiEnabled: v });
            }}
          />
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Organization"
          actions={
            isAdmin && (
              <>
                {dirty && (
                  <Button size="sm" variant="ghost" onClick={() => setForm(base)}>
                    Discard
                  </Button>
                )}
                <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>
                  Save
                </Button>
              </>
            )
          }
        />
        <div className="space-y-4 p-4">
          {save.error ? <ErrorBanner error={save.error} /> : null}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <Input value={form.name} maxLength={120} disabled={!isAdmin} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Timezone" hint="Used for reports and new calendars.">
              <Select value={form.timezone} disabled={!isAdmin} onChange={(e) => set('timezone', e.target.value)}>
                {!tzList.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
                {tzList.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default country" hint="Two-letter code, used to read phone numbers without a country code.">
              <Input value={form.defaultCountry} maxLength={2} disabled={!isAdmin} className="uppercase" onChange={(e) => set('defaultCountry', e.target.value.toUpperCase())} />
            </Field>
            <Field label="Monthly AI budget (USD)" hint="Leave empty for no limit.">
              <NumberInput min={0} step={1} allowEmpty value={form.monthlyAiBudgetUsd} disabled={!isAdmin} onChange={(v) => set('monthlyAiBudgetUsd', v)} />
            </Field>
            <Field label="Currency" hint="For deal values. Existing deals keep the currency they were created in.">
              <Select value={form.currency} disabled={!isAdmin} onChange={(e) => set('currency', e.target.value)}>
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Notification emails" hint="Who gets emailed about handoffs, qualified leads and bookings.">
            <ChipsInput value={form.notificationEmails} disabled={!isAdmin} onChange={(v) => set('notificationEmails', v)} placeholder="frontdesk@example.com" normalize={(s) => s.toLowerCase()} />
          </Field>
          <Field label="Lifecycle stages" hint="The stages a contact moves through, in order. Used by filters and qualification outcomes.">
            <ChipsInput value={form.lifecycleStages} disabled={!isAdmin} onChange={(v) => set('lifecycleStages', v)} placeholder="Add a stage" />
          </Field>
        </div>
      </Card>
    </div>
  );
}

// ---------- Channels ----------

function ChannelsTab({ isAdmin }: { isAdmin: boolean }) {
  const channels = useChannels();
  const bots = useBots();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const rotate = useAction((id: string) => post<Channel>(`/v1/channels/${id}/rotate-key`), { invalidate: [['channels']], success: 'New key created — update the snippet on your website' });
  const remove = useAction((id: string) => del(`/v1/channels/${id}`), { invalidate: [['channels']], success: 'Channel deleted' });
  const webchats = (channels.data ?? []).filter((c) => c.channel === 'webchat');
  const system = (channels.data ?? []).filter((c) => c.channel !== 'webchat');
  const botName = (id: string | null) => (id ? (bots.data?.find((b) => b.id === id)?.name ?? 'Unknown bot') : 'No bot');

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">Website chat</h2>
          <p className="mt-0.5 text-[13px] text-muted">Add the chat widget to your website with one script tag. Each widget can use a different bot and look.</p>
        </div>
        {isAdmin && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New website chat
          </Button>
        )}
      </div>
      {channels.isLoading ? (
        <SkeletonRows rows={4} />
      ) : channels.error ? (
        <ErrorBanner error={channels.error} />
      ) : webchats.length === 0 ? (
        <Card>
          <EmptyState icon={<MessageSquare className="size-5" />} title="No website chat yet" description="Create one, then paste the snippet before </body> on your site." />
        </Card>
      ) : (
        webchats.map((c) => (
          <Card key={c.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <span className="size-3 rounded-full" style={{ background: c.config.theme?.primaryColor ?? '#4f46e5' }} aria-hidden />
                  {c.name}
                  <Badge tone={c.status === 'active' ? 'green' : 'slate'} dot>
                    {c.status === 'active' ? 'Active' : 'Disabled'}
                  </Badge>
                </span>
              }
              description={`${botName(c.botId)} · ${c.config.allowedOrigins?.length ? `allowed on ${c.config.allowedOrigins.join(', ')}` : 'allowed on any website'}`}
              actions={
                isAdmin && (
                  <>
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(c)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RefreshCw className="size-3.5" />}
                      onClick={async () => {
                        if (await confirm({ title: 'Rotate the widget key?', message: 'The current snippet stops working immediately. You will need to update it on your website.', confirmLabel: 'Rotate key', danger: true })) rotate.mutate(c.id);
                      }}
                    >
                      Rotate key
                    </Button>
                    <IconButton
                      label={`Delete ${c.name}`}
                      size="sm"
                      onClick={async () => {
                        if (await confirm({ title: `Delete “${c.name}”?`, message: 'The widget disappears from your website. Past conversations are kept.', confirmLabel: 'Delete', danger: true })) remove.mutate(c.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </>
                )
              }
            />
            <div className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-medium text-fg-2">Embed snippet</p>
                {c.embedSnippet && <CopyButton text={c.embedSnippet} label="Copy snippet" />}
              </div>
              <CodeBlock>{c.embedSnippet ?? '—'}</CodeBlock>
              <p className="text-xs text-muted">
                Paste it just before <code className="font-mono">&lt;/body&gt;</code> on every page where the chat should appear. Public key: <code className="font-mono">{c.publicKey}</code>
              </p>
            </div>
          </Card>
        ))
      )}
      {system.length > 0 && (
        <Card>
          <CardHeader title="System channels" description="Created automatically; they can't be deleted." />
          <ul className="divide-y divide-border">
            {system.map((c) => (
              <li key={c.id} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                <span className="text-fg">{c.name}</span>
                <span className="flex items-center gap-2 text-muted">
                  {botName(c.botId)} <Badge tone="slate">{c.channel === 'api' ? 'API' : 'Playground'}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && <ChannelDialog channel={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ChannelDialog({ channel, onClose }: { channel?: Channel; onClose: () => void }) {
  const bots = useBots();
  const theme = channel?.config.theme ?? {};
  const [form, setForm] = useState(() => ({
    name: channel?.name ?? 'Website chat',
    botId: channel?.botId ?? '',
    status: channel?.status ?? ('active' as Channel['status']),
    greeting: channel?.config.greeting ?? '',
    allowedOrigins: channel?.config.allowedOrigins ?? [],
    primaryColor: theme.primaryColor ?? '#4f46e5',
    position: theme.position ?? ('right' as NonNullable<ChannelTheme['position']>),
    title: theme.title ?? '',
    subtitle: theme.subtitle ?? '',
    launcherText: theme.launcherText ?? '',
    avatarUrl: theme.avatarUrl ?? '',
    draggable: theme.draggable ?? false,
  }));
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const colorValid = /^#[0-9a-fA-F]{6}$/.test(form.primaryColor);
  const selectedBot = bots.data?.find((b) => b.id === form.botId);
  // What the widget itself would show: the bot's name, and its enabled starters ("talk to the team" ones need handoff on).
  const org = useOrg();
  const assistantName = selectedBot?.config.persona.assistantName || 'Assistant';
  const starters = (selectedBot?.config.conversationStarters ?? []).filter(
    (s) => s.enabled && (s.action !== 'handoff' || selectedBot?.config.handoff.enabled),
  );

  const save = useAction(
    () => {
      const themeBody: ChannelTheme = {
        primaryColor: form.primaryColor,
        position: form.position,
        title: form.title,
        subtitle: form.subtitle,
        launcherText: form.launcherText,
        draggable: form.draggable,
      };
      if (form.avatarUrl.trim()) themeBody.avatarUrl = form.avatarUrl.trim();
      const body = {
        name: form.name.trim(),
        botId: form.botId || null,
        status: form.status,
        config: { allowedOrigins: form.allowedOrigins, greeting: form.greeting, theme: themeBody },
      };
      return channel ? patch<Channel>(`/v1/channels/${channel.id}`, body) : post<Channel>('/v1/channels/webchat', body);
    },
    { invalidate: [['channels']], errorToast: false, success: channel ? 'Website chat updated' : 'Website chat created', onSuccess: onClose },
  );

  return (
    <Modal
      open
      size="xl"
      onClose={onClose}
      title={channel ? `Edit ${channel.name}` : 'New website chat'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.name.trim() || !colorValid} onClick={() => save.mutate()}>
            {channel ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_260px] gap-6">
        <div className="space-y-4">
          {save.error ? <ErrorBanner error={save.error} /> : null}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" required>
              <Input value={form.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Bot">
              <Select value={form.botId} onChange={(e) => set('botId', e.target.value)}>
                <option value="">No bot (team replies only)</option>
                {(bots.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Toggle label="Active" description="Disabled widgets don't load on your website." checked={form.status === 'active'} onChange={(v) => set('status', v ? 'active' : 'disabled')} />
          <Field label="Greeting" hint="Leave empty to use the bot's greeting.">
            <Textarea rows={2} maxLength={500} value={form.greeting} placeholder={selectedBot?.config.persona.greeting} onChange={(e) => set('greeting', e.target.value)} />
          </Field>
          <Field label="Allowed websites" hint="Origins like https://www.example.com (no path). Leave empty to allow any site.">
            <ChipsInput value={form.allowedOrigins} onChange={(v) => set('allowedOrigins', v)} normalize={(s) => s.replace(/\/+$/, '')} placeholder="https://www.example.com" />
          </Field>
          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-fg">Appearance</legend>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Brand colour" error={colorValid ? null : 'Use a hex colour like #4f46e5'}>
                <div className="flex gap-2">
                  <input type="color" aria-label="Pick brand colour" className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-border-strong bg-surface p-1" value={colorValid ? form.primaryColor : '#4f46e5'} onChange={(e) => set('primaryColor', e.target.value)} />
                  <Input className="font-mono text-[13px]" value={form.primaryColor} maxLength={7} onChange={(e) => set('primaryColor', e.target.value)} />
                </div>
              </Field>
              <Field label="Position">
                <Select value={form.position} onChange={(e) => set('position', e.target.value as 'right' | 'left')}>
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </Select>
              </Field>
              <Field label="Header title">
                <Input value={form.title} maxLength={80} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <Field label="Header subtitle">
                <Input value={form.subtitle} maxLength={120} placeholder="We usually reply in a minute" onChange={(e) => set('subtitle', e.target.value)} />
              </Field>
              <Field label="Launcher text" hint="Optional label next to the chat bubble.">
                <Input value={form.launcherText} maxLength={40} placeholder="Chat with us" onChange={(e) => set('launcherText', e.target.value)} />
              </Field>
              <Field label="Avatar URL">
                <Input type="url" value={form.avatarUrl} maxLength={500} placeholder="https://…/avatar.png" onChange={(e) => set('avatarUrl', e.target.value)} />
              </Field>
            </div>
            <Toggle
              label="Draggable bubble"
              description="Visitors can drag the chat bubble anywhere on the page while the chat is closed, and it stays where they leave it. Position is where it starts."
              checked={form.draggable}
              onChange={(v) => set('draggable', v)}
            />
          </fieldset>
        </div>
        <WidgetPreview
          color={colorValid ? form.primaryColor : '#4f46e5'}
          position={form.position}
          title={form.title || selectedBot?.config.persona.companyName || org.data?.name || assistantName}
          subtitle={form.subtitle || `${assistantName} · usually replies instantly`}
          greeting={form.greeting || selectedBot?.config.persona.greeting || 'Hi! How can I help?'}
          assistantName={assistantName}
          avatarUrl={form.avatarUrl.trim()}
          starters={starters}
          launcherText={form.launcherText}
          draggable={form.draggable}
        />
      </div>
    </Modal>
  );
}

/** The assistant's picture in the preview: the avatar image, or the initials when there's none (or it won't load). */
function PreviewFace({ src, name, className }: { src: string; name: string; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--c)_12%,transparent)] font-semibold text-(--c) dark:bg-[color-mix(in_srgb,var(--c)_24%,transparent)] dark:text-[color-mix(in_srgb,var(--c)_40%,#fff)] ${className}`}
    >
      {src && failed !== src ? <img src={src} alt="" className="size-full object-cover" onError={() => setFailed(src)} /> : initialsOf(name)}
    </span>
  );
}

const MAGNET_PATHS = (
  <>
    <path d="M5 4v8a7 7 0 0 0 14 0V4h-5v8a2 2 0 0 1-4 0V4Z" />
    <path d="M5 8h5" />
    <path d="M14 8h5" />
  </>
);

/**
 * A small copy of the website chat as visitors see it with these settings (in the dashboard's light or dark mode,
 * like the widget follows the visitor's): the chat open over its bubble.
 */
function WidgetPreview({
  color,
  position,
  title,
  subtitle,
  greeting,
  assistantName,
  avatarUrl,
  starters,
  launcherText,
  draggable,
}: {
  color: string;
  position: 'left' | 'right';
  title: string;
  subtitle: string;
  greeting: string;
  assistantName: string;
  avatarUrl: string;
  starters: Array<{ id: string; label: string }>;
  launcherText: string;
  draggable: boolean;
}) {
  return (
    <div aria-label="Widget preview" className="sticky top-0 self-start">
      <p className="mb-2 text-xs font-medium text-muted">Preview</p>
      <div
        style={{ '--c': color } as CSSProperties}
        className={`flex flex-col gap-2.5 rounded-lg bg-[#eceef2] p-3 dark:bg-[#1b1d22] ${position === 'left' ? 'items-start' : 'items-end'}`}
      >
        <div className="w-full overflow-hidden rounded-2xl bg-white shadow-[0_0_0_1px_rgba(15,23,42,.06),0_12px_28px_-6px_rgba(15,23,42,.16)] dark:bg-[#121418] dark:shadow-[0_0_0_1px_rgba(255,255,255,.07),0_16px_32px_-8px_rgba(0,0,0,.5)]">
          <div className="flex items-center gap-2 border-b border-[#eceef2] py-2.5 pr-2 pl-3 dark:border-[#23262e]">
            <span className="relative shrink-0">
              <PreviewFace src={avatarUrl} name={title} className="size-8 text-[11px]" />
              <span className="absolute -right-px -bottom-px size-2.5 rounded-full border-2 border-white bg-[#16a34a] dark:border-[#121418] dark:bg-[#22c55e]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-4 font-semibold text-[#14161b] dark:text-[#eef0f4]">{title}</span>
              <span className="mt-0.5 flex items-center gap-1 text-[10.5px] leading-4 text-[#5b6475] dark:text-[#a1a9b7]">
                <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--c)_10%,transparent)] px-1 text-[8px] leading-3.5 font-bold tracking-wider text-(--c) dark:bg-[color-mix(in_srgb,var(--c)_24%,transparent)] dark:text-[color-mix(in_srgb,var(--c)_40%,#fff)]">
                  AI
                </span>
                <span className="truncate">{subtitle}</span>
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-[#5b6475] dark:text-[#a1a9b7]" aria-hidden />
          </div>
          <div className="space-y-2.5 px-3 pt-3 pb-2">
            <div className="flex items-end gap-1.5">
              <PreviewFace src={avatarUrl} name={title} className="mb-4 size-5 text-[7.5px]" />
              <div className="min-w-0">
                <p className="rounded-[14px] rounded-bl-[5px] bg-[#f2f3f6] px-2.5 py-1.5 text-xs leading-[17px] text-[#14161b] dark:bg-[#1e2129] dark:text-[#e8eaef]">
                  {greeting}
                </p>
                <p className="mt-0.5 pl-1 text-[10px] leading-3.5 text-[#6b7280] dark:text-[#8f98a8]">{assistantName} · Just now</p>
              </div>
            </div>
            {starters.length ? (
              <div className="flex flex-col items-end gap-1.5 pl-6">
                {starters.slice(0, 3).map((s) => (
                  <span
                    key={s.id}
                    className="max-w-full truncate rounded-full border border-[color-mix(in_srgb,var(--c)_32%,transparent)] bg-white px-2.5 py-1 text-[11px] leading-4 font-medium text-(--c) dark:border-[color-mix(in_srgb,color-mix(in_srgb,var(--c)_70%,#fff)_50%,transparent)] dark:bg-transparent dark:text-[color-mix(in_srgb,var(--c)_45%,#fff)]"
                  >
                    {s.label}
                  </span>
                ))}
                {starters.length > 3 && <span className="text-[10px] text-[#6b7280] dark:text-[#8f98a8]">+{starters.length - 3} more</span>}
              </div>
            ) : (
              <div className="flex justify-end">
                <p className="max-w-[75%] rounded-[14px] rounded-br-[5px] bg-(--c) px-2.5 py-1.5 text-xs leading-[17px] text-white">Do you have openings this week?</p>
              </div>
            )}
          </div>
          <div className="px-2.5">
            <div className="flex items-center gap-2 rounded-xl border border-[#dfe2e8] bg-white py-1 pr-1 pl-2.5 dark:border-[#2b2f38] dark:bg-[#1a1d23]">
              <span className="flex-1 truncate text-[11px] text-[#6b7280] dark:text-[#8f98a8]">Write a message…</span>
              <span className="flex size-6 items-center justify-center rounded-lg bg-(--c) text-white">
                <ArrowUp className="size-3.5" strokeWidth={2.5} aria-hidden />
              </span>
            </div>
          </div>
          <div className="px-2 pt-2 pb-2.5 text-center text-[9px] leading-3 text-[#6b7280] dark:text-[#8f98a8]">
            <p>Chats are recorded so our team can assist you.</p>
            <p>
              Powered by{' '}
              <span className="font-semibold whitespace-nowrap text-[#3f4654] dark:text-[#c9ced8]">
                <svg viewBox="0 0 24 24" className="mr-0.5 inline size-2.5 align-[-1px]" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {MAGNET_PATHS}
                </svg>
                LeadsMagnet AI
              </span>
            </p>
          </div>
        </div>
        <span
          className={`flex h-10 items-center justify-center gap-1.5 rounded-full bg-(--c) text-xs font-semibold text-white shadow-[0_8px_18px_-6px_color-mix(in_srgb,var(--c)_45%,transparent)] ${launcherText ? 'max-w-full pr-3.5 pl-3' : 'w-10'}`}
        >
          <ChevronDown className="size-4 shrink-0" strokeWidth={2.25} aria-hidden />
          {launcherText && <span className="truncate">{launcherText}</span>}
        </span>
      </div>
      {draggable && <p className="mt-2 text-xs text-muted">Starts here; visitors can drag it anywhere.</p>}
    </div>
  );
}

// ---------- Team ----------

function TeamTab({ isAdmin }: { isAdmin: boolean }) {
  const { me } = useAuth();
  const confirm = useConfirm();
  const members = useQuery({ queryKey: ['members'], queryFn: () => get<Member[]>('/v1/members') });
  const [adding, setAdding] = useState(false);
  const remove = useAction((userId: string) => del(`/v1/members/${userId}`), { invalidate: [['members']], success: 'Member removed' });
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">Team</h2>
          <p className="mt-0.5 text-[13px] text-muted">Admins configure bots and settings; agents reply to conversations and manage leads; viewers can only look.</p>
        </div>
        {isAdmin && (
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
            Add member
          </Button>
        )}
      </div>
      <Card>
        {members.isLoading ? (
          <SkeletonRows rows={3} />
        ) : members.error ? (
          <ErrorBanner error={members.error} className="m-4" />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Member</TH>
                <TH>Role</TH>
                <TH>Joined</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </thead>
            <tbody>
              {(members.data ?? []).map((m) => (
                <tr key={m.userId}>
                  <TD>
                    <p className="font-medium text-fg">
                      {m.name || m.email}
                      {m.userId === me?.user.id && <span className="ml-1.5 text-xs font-normal text-muted">(you)</span>}
                    </p>
                    {m.name && <p className="text-xs text-muted">{m.email}</p>}
                  </TD>
                  <TD>
                    <Badge tone={m.role === 'owner' ? 'indigo' : 'slate'}>{m.role}</Badge>
                  </TD>
                  <TD className="text-muted">{formatDate(m.createdAt)}</TD>
                  <TD className="text-right">
                    {isAdmin && m.role !== 'owner' && m.userId !== me?.user.id && (
                      <Button
                        size="xs"
                        variant="danger-ghost"
                        onClick={async () => {
                          if (await confirm({ title: `Remove ${m.name || m.email}?`, message: 'They lose access to this organization immediately.', confirmLabel: 'Remove', danger: true })) remove.mutate(m.userId);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {adding && <AddMemberDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddMemberDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ email: '', name: '', role: 'agent' as Exclude<Role, 'owner'>, password: '' });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const add = useAction(
    () => post<Member>('/v1/members', { email: form.email.trim(), role: form.role, name: form.name.trim() || undefined, password: form.password || undefined }),
    { invalidate: [['members']], errorToast: false, success: 'Member added', onSuccess: onClose },
  );
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a team member"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-member" variant="primary" loading={add.isPending} disabled={!form.email.trim()}>
            Add member
          </Button>
        </>
      }
    >
      <form
        id="add-member"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        {add.error ? <ErrorBanner error={add.error} /> : null}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Email" required>
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Role">
            <Select value={form.role} onChange={(e) => set('role', e.target.value as Exclude<Role, 'owner'>)}>
              <option value="admin">Admin</option>
              <option value="agent">Agent</option>
              <option value="viewer">Viewer</option>
            </Select>
          </Field>
          <Field label="Name">
            <Input value={form.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Initial password" hint="Only needed if they don't have an account yet (8+ characters).">
            <Input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => set('password', e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// ---------- API keys ----------

const SCOPE_HELP: Record<string, string> = {
  'conversations:read': 'Read conversations, their messages and summaries',
  'conversations:write': 'Chat as your customers through the chat API, and read their replies',
  'contacts:read': 'Read contacts, their history, notes, tasks, tags and custom fields',
  'contacts:write': 'Create and update contacts, and add notes and tasks',
  'appointments:read': 'Read calendars, availability and appointments',
  'appointments:write': 'Book, move and cancel appointments (customers are emailed as for staff bookings)',
  'deals:read': 'Read deals and pipelines',
  'deals:write': 'Create, update, move and delete deals',
  'knowledge:write': 'Add documents to knowledge bases',
};

function ApiKeysTab() {
  const confirm = useConfirm();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => get<ApiKey[]>('/v1/api-keys') });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const revoke = useAction((id: string) => del(`/v1/api-keys/${id}`), { invalidate: [['api-keys']], success: 'Key revoked' });
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">API keys</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            For n8n and other server-to-server integrations. Send as <code className="font-mono text-xs">Authorization: Bearer sk_…</code>.
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          Create key
        </Button>
      </div>
      <Card>
        {keys.isLoading ? (
          <SkeletonRows rows={3} />
        ) : keys.error ? (
          <ErrorBanner error={keys.error} className="m-4" />
        ) : !keys.data?.length ? (
          <EmptyState icon={<KeyRound className="size-5" />} title="No API keys" description="Create a key to let n8n or your backend create contacts, add knowledge or chat through the API." />
        ) : (
          <Table>
            <thead>
              <tr>
                <TH>Key</TH>
                <TH>Scopes</TH>
                <TH>Last used</TH>
                <TH>Created</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id} className={k.revokedAt ? 'opacity-60' : ''}>
                  <TD>
                    <p className="font-medium text-fg">{k.name}</p>
                    <code className="font-mono text-xs text-muted">{k.prefix}…</code>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} tone="slate">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  <TD className="text-muted">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'Never'}</TD>
                  <TD className="text-muted">{formatDate(k.createdAt)}</TD>
                  <TD className="text-right">
                    {k.revokedAt ? (
                      <Badge tone="red">Revoked {formatDate(k.revokedAt)}</Badge>
                    ) : (
                      <span className="inline-flex gap-1">
                        <Button size="xs" variant="ghost" onClick={() => setEditing(k)}>
                          Edit
                        </Button>
                        <Button
                          size="xs"
                          variant="danger-ghost"
                          onClick={async () => {
                            if (await confirm({ title: `Revoke “${k.name}”?`, message: 'Integrations using this key stop working immediately.', confirmLabel: 'Revoke key', danger: true })) revoke.mutate(k.id);
                          }}
                        >
                          Revoke
                        </Button>
                      </span>
                    )}
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && (
        <KeyDialog
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setCreated(k);
          }}
        />
      )}
      {editing && <KeyDialog apiKey={editing} onClose={() => setEditing(null)} onCreated={() => setEditing(null)} />}
      {created && (
        <Modal open onClose={() => setCreated(null)} title={`API key “${created.name}”`} size="lg" footer={<Button variant="primary" onClick={() => setCreated(null)}>I've saved it</Button>}>
          <div className="space-y-4">
            <p className="rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning-text">Copy this key now — it won't be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-fg">{created.key}</code>
              <CopyButton text={created.key} />
            </div>
            <p className="text-[13px] text-fg-2">Example:</p>
            <CodeBlock>{`curl ${API_URL}/v1/contacts \\\n  -H "Authorization: Bearer ${created.key}"`}</CodeBlock>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Create a key, or (with `apiKey`) rename one and change its scopes: integrations keep the same key. */
function KeyDialog({ apiKey, onClose, onCreated }: { apiKey?: ApiKey; onClose: () => void; onCreated: (k: CreatedApiKey) => void }) {
  const [name, setName] = useState(apiKey?.name ?? '');
  const [scopes, setScopes] = useState<string[]>(apiKey?.scopes ?? ['contacts:read', 'contacts:write']);
  const create = useAction(
    () =>
      apiKey
        ? patch<CreatedApiKey>(`/v1/api-keys/${apiKey.id}`, { name: name.trim(), scopes: API_KEY_SCOPES.filter((s) => scopes.includes(s)) })
        : post<CreatedApiKey>('/v1/api-keys', { name: name.trim(), scopes: API_KEY_SCOPES.filter((s) => scopes.includes(s)) }),
    { invalidate: [['api-keys']], errorToast: false, onSuccess: onCreated, success: apiKey ? 'Key updated: the change applies to its next request' : undefined },
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={apiKey ? `Edit “${apiKey.name}”` : 'Create API key'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-key" variant="primary" loading={create.isPending} disabled={!name.trim() || scopes.length === 0}>
            {apiKey ? 'Save' : 'Create key'}
          </Button>
        </>
      }
    >
      <form
        id="create-key"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {create.error ? <ErrorBanner error={create.error} /> : null}
        <Field label="Name" required hint="Where it's used, e.g. “n8n production”.">
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium text-fg-2">Scopes</legend>
          {API_KEY_SCOPES.map((s) => (
            <Checkbox
              key={s}
              label={<code className="font-mono text-xs">{s}</code>}
              description={SCOPE_HELP[s]}
              checked={scopes.includes(s)}
              onChange={(e) => setScopes((list) => (e.target.checked ? [...list, s] : list.filter((x) => x !== s)))}
            />
          ))}
        </fieldset>
      </form>
    </Modal>
  );
}
