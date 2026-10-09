import { ChevronRight, Code2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from '../../../components/overlay';
import { Badge, Button, Checkbox, CodeBlock, cx, ErrorBanner, Field, IconButton, Input, Select, Textarea, Toggle } from '../../../components/ui';
import { post } from '../../../lib/api';
import { finalizeKey } from '../../../lib/validate';
import type { CustomApi, CustomApiParam, CustomApiTestResult } from '../../../lib/types';
import { parseCurl } from './curl';

type Tab = 'connect' | 'auth' | 'general' | 'test';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'connect', label: 'Connect to API' },
  { id: 'auth', label: 'Authentication' },
  { id: 'general', label: 'General' },
  { id: 'test', label: 'Test' },
];

/** Filled by the server: never asked of the customer. */
export const API_BUILTINS = ['contact.name', 'contact.email', 'contact.phone', 'contact.id', 'conversation.id'] as const;
const PARAM_NAME = /^[a-z0-9_]+$/;

export function blankApi(): CustomApi {
  return {
    key: '',
    name: '',
    description: '',
    method: 'POST',
    url: '',
    contentType: 'application/json',
    headers: [],
    query: [],
    rawBody: false,
    body: '',
    params: [],
    auth: { type: 'none', headerName: 'x-api-key', username: '' },
    waitForResponse: true,
    timeoutMs: 10_000,
    askFirst: false,
    enabled: true,
  };
}

function placeholders(api: CustomApi): string[] {
  const texts = [api.url, ...api.headers.map((h) => h.value), ...api.query.map((q) => q.value), api.rawBody ? api.body : ''];
  const found = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi)) found.add(m[1]!);
  return [...found];
}

type Problems = Partial<Record<'url' | 'name' | 'description' | 'secret' | 'params' | 'body' | 'headers', string>>;

/** The checks the server makes, here first so the field to fix is shown on its tab. */
function check(api: CustomApi, secret: string, others: CustomApi[]): Problems {
  const p: Problems = {};
  if (!/^https?:\/\/[^\s/]+/i.test(api.url.trim())) p.url = 'Enter the full address, starting with https://';
  if (!api.name.trim()) p.name = 'Give the API a name.';
  else if (others.some((o) => o.key === finalizeKey(api.name))) p.name = 'Another API already has this name.';
  if (!api.description.trim()) p.description = 'Say when the agent should call it.';
  if (api.auth.type !== 'none' && !api.auth.hasSecret && !secret.trim())
    p.secret = `Enter the ${api.auth.type === 'basic' ? 'password' : api.auth.type === 'bearer' ? 'token' : 'API key'}.`;
  const names = api.params.map((x) => x.name);
  if (names.some((n) => !PARAM_NAME.test(n))) p.params = 'Input names use lowercase letters, digits and _ only.';
  else if (new Set(names).size !== names.length) p.params = 'Two inputs have the same name.';
  const unknown = placeholders(api).filter((n) => !names.includes(n) && !(API_BUILTINS as readonly string[]).includes(n));
  if (unknown.length) p.params = `Add ${unknown.map((n) => `{{${n}}}`).join(', ')} as ${unknown.length === 1 ? 'an input' : 'inputs'} (General tab), or remove it from the request.`;
  if (api.rawBody && api.method === 'GET') p.body = "GET requests can't send a body: choose another method or turn the raw body off.";
  if ([...api.headers, ...api.query].some((h) => !h.name.trim() || h.name.includes(':'))) p.headers = 'Every header and query parameter needs a name (no colons).';
  return p;
}

const TAB_OF: Record<keyof Problems, Tab> = { url: 'connect', body: 'connect', headers: 'connect', secret: 'auth', name: 'general', description: 'general', params: 'general' };

/**
 * GHL's "Create custom API": where to send the request (or import a cURL command), how to sign in, what the agent
 * collects and when it calls it, and a test send. Proceed puts it on the draft; nothing is saved until Save.
 */
export function CustomApiModal({
  open,
  initial,
  others,
  botId,
  onApply,
  onRemove,
  onClose,
}: {
  open: boolean;
  /** The API being edited, or null for a new one. */
  initial: CustomApi | null;
  /** The bot's other APIs, for unique names. */
  others: CustomApi[];
  botId: string;
  onApply: (api: CustomApi) => void;
  onRemove: (() => void) | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('connect');
  const [api, setApi] = useState<CustomApi>(() => initial ?? blankApi());
  const [secret, setSecret] = useState('');
  const [shown, setShown] = useState<Partial<Record<keyof Problems, boolean>>>({});
  const [curlOpen, setCurlOpen] = useState(false);
  const [curl, setCurl] = useState('');
  const [curlError, setCurlError] = useState<string | null>(null);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CustomApiTestResult | null>(null);
  const [testError, setTestError] = useState<unknown>(null);

  // Each opening starts from what's on the draft.
  useEffect(() => {
    if (!open) return;
    setApi(initial ? structuredClone(initial) : blankApi());
    setSecret('');
    setTab('connect');
    setShown({});
    setCurlOpen(false);
    setCurl('');
    setCurlError(null);
    setSamples({});
    setTestResult(null);
    setTestError(null);
  }, [open, initial]);

  const set = <K extends keyof CustomApi>(key: K, value: CustomApi[K]) => setApi((a) => ({ ...a, [key]: value }));
  const setAuth = (patch: Partial<CustomApi['auth']>) => setApi((a) => ({ ...a, auth: { ...a.auth, ...patch } }));
  const problems = check(api, secret, others);
  const err = (key: keyof Problems) => (shown[key] ? problems[key] : undefined);

  /** What goes on the draft: the key comes from the name, and a new credential travels as `secret` (write-only). */
  const finished = (): CustomApi => ({
    ...api,
    key: finalizeKey(api.name) || 'api',
    name: api.name.trim(),
    description: api.description.trim(),
    url: api.url.trim(),
    auth: api.auth.type === 'none' ? { type: 'none', headerName: api.auth.headerName, username: '' } : { ...api.auth, ...(secret.trim() ? { secret: secret.trim() } : {}) },
  });

  const proceed = () => {
    const keys = Object.keys(problems) as Array<keyof Problems>;
    if (keys.length) {
      setShown(Object.fromEntries(keys.map((k) => [k, true])));
      setTab(TAB_OF[keys[0]!]);
      return;
    }
    onApply(finished());
  };

  const importCurl = () => {
    try {
      const { api: imported, secret: found } = parseCurl(curl);
      setApi((a) => ({ ...a, ...imported, auth: { ...a.auth, ...imported.auth, hasSecret: imported.auth.type === a.auth.type ? a.auth.hasSecret : false } }));
      if (found) setSecret(found);
      setCurlOpen(false);
      setCurl('');
      setCurlError(null);
    } catch (e) {
      setCurlError(e instanceof Error ? e.message : 'That command could not be read.');
    }
  };

  const runTest = async () => {
    const urlProblem = problems.url ?? problems.secret ?? problems.body ?? problems.headers;
    if (urlProblem) {
      setShown({ url: true, secret: true, body: true, headers: true });
      setTestError(urlProblem);
      return;
    }
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    const inputs: Record<string, string | number | boolean> = {};
    const builtins: Record<string, string> = {};
    for (const [name, value] of Object.entries(samples)) {
      if (value === '') continue;
      if ((API_BUILTINS as readonly string[]).includes(name)) builtins[name] = value;
      else {
        const param = api.params.find((x) => x.name === name);
        inputs[name] = param?.type === 'number' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : param?.type === 'boolean' ? value === 'true' : value;
      }
    }
    try {
      const draft = finished();
      const { secret: _secret, ...auth } = draft.auth;
      setTestResult(await post<CustomApiTestResult>(`/v1/bots/${botId}/custom-apis/test`, { api: { ...draft, auth }, secret: secret.trim() || undefined, inputs, builtins }));
    } catch (e) {
      setTestError(e);
    } finally {
      setTesting(false);
    }
  };

  const used = placeholders(api).filter((n) => (API_BUILTINS as readonly string[]).includes(n));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Create custom API"
      description="Call an external API during the conversation"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {onRemove && (
            <Button variant="danger-ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={onRemove}>
              Remove
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={proceed}>
            Proceed
          </Button>
        </div>
      }
    >
      <div role="tablist" aria-label="Custom API" className="-mt-2 mb-5 flex gap-5 overflow-x-auto border-b border-border">
        {TABS.map((t) => {
          const bad = (Object.keys(problems) as Array<keyof Problems>).some((k) => shown[k] && TAB_OF[k] === t.id);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cx('flex items-center gap-1.5 pb-2.5 text-[15px] whitespace-nowrap', tab === t.id ? 'text-accent-text shadow-[inset_0_-2px_0_var(--accent)]' : 'text-fg-2 hover:text-fg')}
            >
              {t.id === 'connect' && <Code2 className="size-4" aria-hidden />}
              {t.label}
              {bad && <span className="size-1.5 rounded-full bg-danger" aria-label="has a problem" />}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" className="space-y-5">
        {tab === 'connect' && (
          <>
            {curlOpen ? (
              <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
                <Field label="Paste a cURL command" error={curlError}>
                  <Textarea rows={4} className="font-mono text-caption" value={curl} onChange={(e) => setCurl(e.target.value)} placeholder="curl -X POST https://api.example.com/orders -H 'Authorization: Bearer …' -d '{…}'" />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setCurlOpen(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" disabled={!curl.trim()} onClick={importCurl}>
                    Import
                  </Button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setCurlOpen(true)} className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface-2 p-3.5 text-left hover:border-border-strong">
                <span className="rounded bg-fg px-2 py-0.5 font-mono text-[11px] font-bold text-bg">CURL</span>
                <span className="flex-1">
                  <span className="block font-medium text-fg">Import cURL</span>
                  <span className="block text-caption text-muted">Quickly populate settings from a cURL command</span>
                </span>
                <ChevronRight className="size-4 text-muted" aria-hidden />
              </button>
            )}
            <Field label="Endpoint URL" error={err('url')} hint="Use {{input}} for values the agent collects, e.g. https://api.example.com/orders/{{order_id}}">
              <div className="flex">
                <Select aria-label="Method" className="w-28 rounded-r-none" value={api.method} onChange={(e) => set('method', e.target.value as CustomApi['method'])}>
                  {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
                <Input className="-ml-px rounded-l-none" type="url" value={api.url} onChange={(e) => set('url', e.target.value)} placeholder="Enter endpoint URL, https://api.example.com/endpoint" />
              </div>
            </Field>
            <Field label="Content-Type">
              <Select value={api.contentType} onChange={(e) => set('contentType', e.target.value as CustomApi['contentType'])}>
                <option value="application/json">application/json</option>
                <option value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</option>
              </Select>
            </Field>
            <Pairs label="Headers" addLabel="Add header" rows={api.headers} onChange={(rows) => set('headers', rows)} hint="Put keys and tokens under Authentication: they're stored encrypted there." />
            <Pairs label="Query parameters" addLabel="Add query params" rows={api.query} onChange={(rows) => set('query', rows)} />
            {err('headers') && <p className="text-caption text-danger-text">{err('headers')}</p>}
            <Toggle
              label="Use a raw JSON body"
              description={
                api.rawBody
                  ? 'Write the body yourself; {{input}} values are filled in.'
                  : api.method === 'GET' || api.method === 'DELETE'
                    ? 'Off: the inputs the agent collects go in the query string.'
                    : 'Off: the inputs the agent collects are sent as the body.'
              }
              checked={api.rawBody}
              onChange={(v) => set('rawBody', v)}
            />
            {api.rawBody && (
              <Field label="Body" error={err('body')}>
                <Textarea rows={6} className="font-mono text-caption" value={api.body} onChange={(e) => set('body', e.target.value)} placeholder={'{\n  "email": "{{contact.email}}",\n  "order": "{{order_id}}"\n}'} />
              </Field>
            )}
            <p className="text-caption text-muted">
              Filled in by the server, never asked of the customer: {API_BUILTINS.map((b) => `{{${b}}}`).join(', ')}.
            </p>
          </>
        )}

        {tab === 'auth' && (
          <>
            <Field label="Authentication">
              <Select value={api.auth.type} onChange={(e) => setAuth({ type: e.target.value as CustomApi['auth']['type'] })}>
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="api_key">API key in a header</option>
                <option value="basic">Basic auth (user name and password)</option>
              </Select>
            </Field>
            {api.auth.type === 'api_key' && (
              <Field label="Header name">
                <Input value={api.auth.headerName} onChange={(e) => setAuth({ headerName: e.target.value })} placeholder="x-api-key" />
              </Field>
            )}
            {api.auth.type === 'basic' && (
              <Field label="User name">
                <Input value={api.auth.username} onChange={(e) => setAuth({ username: e.target.value })} autoComplete="off" />
              </Field>
            )}
            {api.auth.type !== 'none' && (
              <Field
                label={api.auth.type === 'basic' ? 'Password' : api.auth.type === 'bearer' ? 'Token' : 'API key'}
                error={err('secret')}
                hint={api.auth.hasSecret ? 'Saved and encrypted. Leave empty to keep it, or enter a new one to replace it.' : 'Stored encrypted. It is never shown again, not even to admins.'}
              >
                <Input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={api.auth.hasSecret ? '••••••••  (saved)' : ''} />
              </Field>
            )}
          </>
        )}

        {tab === 'general' && (
          <>
            <Field label="Name" error={err('name')} hint={api.name.trim() ? `The agent knows it as “${finalizeKey(api.name) || 'api'}”.` : 'e.g. Order status'}>
              <Input value={api.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="When should the agent call it?" error={err('description')} hint="The agent reads this to decide. Be specific about the moment and what it needs first.">
              <Textarea rows={3} maxLength={600} value={api.description} onChange={(e) => set('description', e.target.value)} placeholder="When the customer asks where their order is and has given the order number." />
            </Field>
            <ParamsEditor params={api.params} onChange={(params) => set('params', params)} error={err('params')} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Wait for the response">
                <Select value={api.waitForResponse ? 'yes' : 'no'} onChange={(e) => set('waitForResponse', e.target.value === 'yes')}>
                  <option value="yes">Yes, the agent uses what comes back</option>
                  <option value="no">No, call it and carry on</option>
                </Select>
              </Field>
              <Field label="Give up after (seconds)">
                <Select value={String(api.timeoutMs)} onChange={(e) => set('timeoutMs', Number(e.target.value))}>
                  {[3000, 5000, 10000, 15000, 20000].map((ms) => (
                    <option key={ms} value={ms}>
                      {ms / 1000}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Toggle label="Ask the team first" description="Each call waits for a team member to approve it in Agent Logs; the customer is told the team will confirm." checked={api.askFirst} onChange={(v) => set('askFirst', v)} />
            <Toggle label="On" description="Off keeps the settings but the agent can't call it." checked={api.enabled} onChange={(v) => set('enabled', v)} />
          </>
        )}

        {tab === 'test' && (
          <>
            <p className="text-body-sm text-fg-2">Send a request with sample values and check what comes back before you save. It really calls the API.</p>
            {api.params.length + used.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {[...api.params.map((x) => x.name), ...used].map((name) => (
                  <Field key={name} label={`{{${name}}}`}>
                    <Input value={samples[name] ?? ''} onChange={(e) => setSamples((s) => ({ ...s, [name]: e.target.value }))} placeholder="Sample value" />
                  </Field>
                ))}
              </div>
            ) : (
              <p className="text-caption text-muted">This request has no inputs.</p>
            )}
            <Button variant="primary" loading={testing} onClick={() => void runTest()}>
              Send test request
            </Button>
            {testError ? <ErrorBanner error={testError} /> : null}
            {testResult && (
              <div className="space-y-2">
                <p className="flex flex-wrap items-center gap-2 text-body-sm text-fg-2">
                  <Badge tone={testResult.ok ? 'green' : 'red'}>HTTP {testResult.status}</Badge>
                  <span className="font-mono text-caption">
                    {testResult.request.method} {testResult.request.url}
                  </span>
                  <span>· {testResult.durationMs} ms</span>
                  {testResult.truncated && <span>· cut short</span>}
                </p>
                <CodeBlock className="max-h-64 overflow-y-auto">{typeof testResult.response === 'string' ? testResult.response || '(empty)' : JSON.stringify(testResult.response, null, 2)}</CodeBlock>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function Pairs({ label, addLabel, rows, onChange, hint }: { label: string; addLabel: string; rows: Array<{ name: string; value: string }>; onChange: (rows: Array<{ name: string; value: string }>) => void; hint?: ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-body-sm font-medium text-fg-2">{label}</legend>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2">
          <Input aria-label={`${label} ${i + 1} name`} placeholder="Name" value={row.name} onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
          <Input aria-label={`${label} ${i + 1} value`} placeholder="Value" value={row.value} onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
          <IconButton label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" className="text-accent-text" icon={<Plus className="size-3.5" aria-hidden />} disabled={rows.length >= 20} onClick={() => onChange([...rows, { name: '', value: '' }])}>
        {addLabel}
      </Button>
      {hint && <p className="text-caption text-muted">{hint}</p>}
    </fieldset>
  );
}

function ParamsEditor({ params, onChange, error }: { params: CustomApiParam[]; onChange: (p: CustomApiParam[]) => void; error?: string }) {
  const update = (i: number, patch: Partial<CustomApiParam>) => onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <fieldset className="space-y-2">
      <legend className="text-body-sm font-medium text-fg-2">Inputs the agent collects</legend>
      <p className="text-caption text-muted">Each one becomes {'{{name}}'} in the request. The agent asks the customer for the required ones first.</p>
      {params.map((p, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_120px_auto_auto]">
          <Input aria-label={`Input ${i + 1} name`} placeholder="order_id" value={p.name} onChange={(e) => update(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
          <Select aria-label={`Input ${i + 1} type`} value={p.type} onChange={(e) => update(i, { type: e.target.value as CustomApiParam['type'] })}>
            <option value="string">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Yes / no</option>
          </Select>
          <Checkbox className="self-center" label="Required" checked={p.required} onChange={(e) => update(i, { required: e.target.checked })} />
          <IconButton label={`Remove input ${i + 1}`} onClick={() => onChange(params.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </IconButton>
          <Input className="sm:col-span-4" aria-label={`Input ${i + 1} description`} placeholder="What it is, e.g. The order number on their receipt" value={p.description} onChange={(e) => update(i, { description: e.target.value })} />
        </div>
      ))}
      <Button size="sm" variant="ghost" className="text-accent-text" icon={<Plus className="size-3.5" aria-hidden />} disabled={params.length >= 15} onClick={() => onChange([...params, { name: '', type: 'string', description: '', required: true }])}>
        Add input
      </Button>
      {error && <p className="text-caption text-danger-text">{error}</p>}
    </fieldset>
  );
}
