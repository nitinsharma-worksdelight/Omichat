import type { Scope } from '../../db/tenant';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { fetchLimited } from '../../lib/net';
import { apiPlaceholders, CustomApiSchema, type CustomApi } from '../bots/config';
import type { BotsService } from '../bots/service';

/**
 * The "API Call" action: builds the request a custom API describes from the values the assistant collected (and the
 * server's own: the contact, the conversation), sends it to the business's endpoint and hands back what came back.
 */

export type ApiInputValue = string | number | boolean;

export interface ApiCallValues {
  /** What the assistant collected, by input name. */
  inputs: Record<string, ApiInputValue>;
  /** `contact.email`, `conversation.id`…, from the server. Missing ones are filled with "". */
  builtins: Record<string, string | null | undefined>;
}

export interface BuiltRequest {
  method: CustomApi['method'];
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** The most of a response the assistant (or the test panel) sees. */
const RESPONSE_CHARS = 4000;
const MAX_RESPONSE_BYTES = 512_000;

const PLACEHOLDER = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

function fill(text: string, values: ApiCallValues, encode: (value: string) => string): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const value = name in values.inputs ? values.inputs[name] : values.builtins[name];
    return encode(value === undefined || value === null ? '' : String(value));
  });
}

/** One line, so a filled-in value can't add a header of its own. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ');
/** Inside a JSON string: quotes, backslashes and control characters escaped (the template supplies the quotes). */
const jsonText = (value: string) => JSON.stringify(value).slice(1, -1);

/** The request this API makes with these values. Throws a 400 with a plain message when it can't be built. */
export function buildRequest(api: CustomApi, secret: string | null, values: ApiCallValues): BuiltRequest {
  let url: URL;
  try {
    url = new URL(fill(api.url, values, encodeURIComponent));
  } catch {
    throw badRequest(`"${api.name}" doesn't have a valid endpoint URL`);
  }
  for (const q of api.query) url.searchParams.append(q.name, fill(q.value, values, oneLine));

  const headers: Record<string, string> = {};
  for (const h of api.headers) headers[h.name.toLowerCase()] = fill(h.value, values, oneLine);
  if (api.auth.type !== 'none') {
    if (!secret) throw badRequest(`"${api.name}" needs its ${api.auth.type === 'basic' ? 'password' : api.auth.type === 'bearer' ? 'token' : 'API key'}`);
    if (api.auth.type === 'bearer') headers.authorization = `Bearer ${secret}`;
    else if (api.auth.type === 'api_key') headers[(api.auth.headerName || 'x-api-key').toLowerCase()] = secret;
    else headers.authorization = `Basic ${Buffer.from(`${api.auth.username}:${secret}`).toString('base64')}`;
  }

  const sendsBody = api.method !== 'GET' && api.method !== 'DELETE';
  let body: string | undefined;
  if (api.rawBody) {
    if (sendsBody && api.body.trim()) {
      body = fill(api.body, values, api.contentType === 'application/json' ? jsonText : encodeURIComponent);
      if (api.contentType === 'application/json') {
        try {
          JSON.parse(body);
        } catch {
          throw badRequest(`"${api.name}": the body isn't valid JSON once the values are filled in`);
        }
      }
    }
  } else {
    // Inputs not placed anywhere go in the body (or, for GET and DELETE, the query string).
    const used = new Set(apiPlaceholders(api));
    const rest = Object.entries(values.inputs).filter(([name]) => !used.has(name));
    if (!sendsBody) for (const [name, value] of rest) url.searchParams.append(name, String(value));
    else if (rest.length) {
      body =
        api.contentType === 'application/json'
          ? JSON.stringify(Object.fromEntries(rest))
          : new URLSearchParams(rest.map(([name, value]) => [name, String(value)])).toString();
    }
  }
  if (body !== undefined) headers['content-type'] = api.contentType;
  return { method: api.method, url: url.toString(), headers, body };
}

/**
 * Checks what the assistant passed against the API's inputs: required ones present, numbers and yes/no values
 * converted. Returns the clean values or the problems, in words the assistant can act on.
 */
export function checkInputs(api: CustomApi, raw: Record<string, unknown>): { ok: true; inputs: Record<string, ApiInputValue> } | { ok: false; problems: string[] } {
  const inputs: Record<string, ApiInputValue> = {};
  const problems: string[] = [];
  for (const p of api.params) {
    const value = raw[p.name];
    if (value === undefined || value === null || value === '') {
      if (p.required) problems.push(`missing "${p.name}"${p.description ? ` (${p.description})` : ''}`);
      continue;
    }
    if (p.type === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) problems.push(`"${p.name}" must be a number`);
      else inputs[p.name] = n;
    } else if (p.type === 'boolean') inputs[p.name] = value === true || value === 'true' || value === 'yes';
    else inputs[p.name] = String(value).slice(0, 2000);
  }
  return problems.length ? { ok: false, problems } : { ok: true, inputs };
}

export interface ApiResult {
  ok: boolean;
  status: number;
  /** Parsed JSON when the API answered with JSON, else the text; cut to a few thousand characters. */
  response: unknown;
  truncated: boolean;
  durationMs: number;
}

export class CustomApiService {
  constructor(
    private readonly bots: BotsService,
    private readonly opts: { allowPrivateUrls: boolean },
  ) {}

  /** Calls one of a bot's APIs as it is saved now. */
  async call(scope: Scope, botId: string, apiId: string, values: ApiCallValues): Promise<ApiResult> {
    const found = await this.bots.customApi(scope, botId, apiId);
    if (!found || !found.api.enabled) throw notFound('API');
    return this.send(found.api, found.secret, values);
  }

  /**
   * The Test tab: sends a draft definition with sample values. Without a new credential, a saved API's stored one is
   * used (the draft names the bot and API it came from).
   */
  async test(scope: Scope, input: { botId: string; api: unknown; secret?: string; inputs: Record<string, unknown>; builtins: Record<string, string> }): Promise<ApiResult & { request: { method: string; url: string } }> {
    const parsed = CustomApiSchema.safeParse(input.api);
    if (!parsed.success) throw badRequest('Check the API settings first', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const api = parsed.data;
    let secret = input.secret?.trim() || null;
    if (!secret && api.auth.type !== 'none' && api.id) secret = (await this.bots.customApi(scope, input.botId, api.id))?.secret ?? null;
    const checked = checkInputs(api, input.inputs);
    if (!checked.ok) throw badRequest(`Fill in the sample values: ${checked.problems.join('; ')}`);
    const values = { inputs: checked.inputs, builtins: input.builtins };
    const request = buildRequest(api, secret, values);
    const result = await this.send(api, secret, values);
    // Shown to the person testing: the address without its query string, which may carry a key.
    return { ...result, request: { method: request.method, url: request.url.split('?')[0]! } };
  }

  private async send(api: CustomApi, secret: string | null, values: ApiCallValues): Promise<ApiResult> {
    const request = buildRequest(api, secret, values);
    const started = Date.now();
    let res: Awaited<ReturnType<typeof fetchLimited>>;
    try {
      res = await fetchLimited(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeoutMs: api.timeoutMs,
        maxBytes: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        allowPrivate: this.opts.allowPrivateUrls,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      const timedOut = (err as { name?: string }).name === 'TimeoutError';
      throw badRequest(timedOut ? `"${api.name}" didn't answer within ${Math.round(api.timeoutMs / 1000)} seconds` : `Couldn't reach "${api.name}"`);
    }
    const text = res.body.toString('utf8');
    const truncated = text.length > RESPONSE_CHARS;
    let response: unknown = truncated ? `${text.slice(0, RESPONSE_CHARS)}…` : text;
    if (!truncated && /json/i.test(res.contentType)) {
      try {
        response = JSON.parse(text);
      } catch {
        // Not really JSON: passed on as text.
      }
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, response, truncated, durationMs: Date.now() - started };
  }
}
