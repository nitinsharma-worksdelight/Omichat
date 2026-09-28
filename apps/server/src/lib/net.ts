import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { badRequest } from './errors';

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return mapped ? isPrivateIPv4(mapped[1]!) : false;
}

/**
 * SSRF guard for URLs supplied by tenants (knowledge-base URLs, webhook targets): http(s) only and,
 * unless allowed, no loopback/private/link-local destinations (cloud metadata endpoints included).
 */
export async function assertSafeUrl(raw: string, opts: { allowPrivate: boolean }): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('Only http(s) URLs are allowed');
  if (url.username || url.password) throw badRequest('URLs with credentials are not allowed');
  if (opts.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw badRequest(`Could not resolve ${url.hostname}`);
  for (const { address } of addresses) {
    if (isIP(address) === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address)) {
      throw badRequest('URLs pointing at private or local networks are not allowed');
    }
  }
  return url;
}

/**
 * fetch with a timeout, a response size cap, and redirects followed manually so every hop can be
 * re-validated (a public URL must not be able to redirect us into the private network).
 */
export async function fetchLimited(
  url: string,
  opts: {
    timeoutMs: number;
    maxBytes: number;
    headers?: Record<string, string>;
    method?: 'GET' | 'POST';
    body?: string;
    validate?: (url: string) => Promise<unknown>;
    maxRedirects?: number;
  },
): Promise<{ status: number; contentType: string; body: Buffer; finalUrl: string }> {
  let current = url;
  let res: Response | undefined;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    await opts.validate?.(current);
    res = await fetch(current, {
      method: opts.method ?? 'GET',
      body: opts.body,
      headers: { 'user-agent': 'OmniAI/1.0', ...opts.headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    break;
  }
  if (!res || (res.status >= 300 && res.status < 400 && opts.maxRedirects !== 0)) throw badRequest(`Too many redirects fetching ${url}`);
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel();
        throw badRequest(`Response from ${url} is larger than ${Math.round(opts.maxBytes / 1e6)} MB`);
      }
      chunks.push(value);
    }
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks), finalUrl: current };
}
