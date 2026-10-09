import type { CustomApi, CustomApiMethod } from '../../../lib/types';

/** Splits a shell command into words, honouring single and double quotes and backslash line breaks. */
function words(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  const text = command.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new Error('A quote is never closed.');
  if (started) out.push(current);
  return out;
}

const METHODS: CustomApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** What a cURL command fills in: the request, and a credential found in it (kept apart, as it's write-only). */
export interface ImportedCurl {
  api: Pick<CustomApi, 'method' | 'url' | 'contentType' | 'headers' | 'query' | 'rawBody' | 'body' | 'auth'>;
  secret: string | null;
}

/** Reads `curl -X POST https://… -H 'Name: value' -d '{…}' -u user:pass`. Throws an Error with a plain message. */
export function parseCurl(command: string): ImportedCurl {
  const parts = words(command.trim());
  if (parts[0]?.toLowerCase() !== 'curl') throw new Error('Paste a command that starts with curl.');
  let method: string | null = null;
  let url: string | null = null;
  const headers: Array<{ name: string; value: string }> = [];
  let body: string | null = null;
  let user: string | null = null;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    const next = () => {
      const v = parts[++i];
      if (v === undefined) throw new Error(`${p} needs a value.`);
      return v;
    };
    if (p === '-X' || p === '--request') method = next().toUpperCase();
    else if (p === '-H' || p === '--header') {
      const h = next();
      const at = h.indexOf(':');
      if (at > 0) headers.push({ name: h.slice(0, at).trim(), value: h.slice(at + 1).trim() });
    } else if (p === '-d' || p === '--data' || p === '--data-raw' || p === '--data-binary' || p === '--json') {
      const value = next();
      body = body === null ? value : `${body}&${value}`;
      if (p === '--json') headers.push({ name: 'Content-Type', value: 'application/json' });
    } else if (p === '-u' || p === '--user') user = next();
    else if (p === '--url') url = next();
    else if (/^https?:\/\//i.test(p)) url = p;
    else if (p.startsWith('-')) {
      // Flags with a value we don't use (--max-time 5, -o file…) skip it; lone flags (-s, -L, --compressed) don't.
      if (/^(-o|--output|-m|--max-time|--connect-timeout|-A|--user-agent|-e|--referer|-b|--cookie)$/.test(p)) i++;
    }
  }
  if (!url) throw new Error('No https:// address found in the command.');
  const parsed = new URL(url);
  const query = [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  parsed.search = '';
  const m = (method ?? (body !== null ? 'POST' : 'GET')) as CustomApiMethod;
  if (!METHODS.includes(m)) throw new Error(`${m} requests aren't supported.`);

  let secret: string | null = null;
  let auth: CustomApi['auth'] = { type: 'none', headerName: 'x-api-key', username: '' };
  const kept: Array<{ name: string; value: string }> = [];
  let contentType: CustomApi['contentType'] = 'application/json';
  for (const h of headers) {
    const lower = h.name.toLowerCase();
    const bearer = /^bearer\s+(.+)$/i.exec(h.value);
    if (lower === 'authorization' && bearer) {
      auth = { ...auth, type: 'bearer' };
      secret = bearer[1]!.trim();
    } else if (/^(x-api-key|api-key|apikey|x-auth-token)$/.test(lower) && auth.type === 'none') {
      auth = { ...auth, type: 'api_key', headerName: h.name };
      secret = h.value;
    } else if (lower === 'content-type') {
      contentType = /x-www-form-urlencoded/i.test(h.value) ? 'application/x-www-form-urlencoded' : 'application/json';
    } else if (lower !== 'content-length' && lower !== 'host') kept.push(h);
  }
  if (user !== null) {
    const at = user.indexOf(':');
    auth = { ...auth, type: 'basic', username: at === -1 ? user : user.slice(0, at) };
    secret = at === -1 ? null : user.slice(at + 1);
  }
  return {
    api: { method: m, url: parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '' : '/'), contentType, headers: kept, query, rawBody: body !== null, body: body ?? '', auth },
    secret,
  };
}
