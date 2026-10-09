import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { badRequest } from './errors';

const PRIVATE_URL_MESSAGE = 'URLs pointing at private or local networks are not allowed';

/** Every range a tenant-supplied URL must never reach: loopback, private, link-local, shared, reserved, multicast. */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (the IPv4 inside is obfuscated)
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** The 16 bytes of an IPv6 address (any textual form, including a trailing dotted IPv4), or null. */
function ipv6Bytes(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split('.').map(Number);
    text = `${text.slice(0, -dotted[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => Number.parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

/** The IPv4 address an IPv6 address carries (mapped, compatible, translated, NAT64 or 6to4), if any. */
function embeddedIPv4(bytes: number[]): string | null {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  const v4 = (at: number) => bytes.slice(at, at + 4).join('.');
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return v4(12); // ::ffff:a.b.c.d (mapped)
  if (zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zeros(10, 12)) return v4(12); // ::ffff:0:a.b.c.d (translated)
  if (zeros(0, 12)) return v4(12); // ::a.b.c.d (compatible)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return v4(12); // 64:ff9b::/96 (NAT64)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4(2); // 2002::/16 (6to4)
  return null;
}

/**
 * Whether a resolved address is safe for a tenant-supplied URL. IPv6 forms that carry an IPv4 address are judged by
 * that address, so `::ffff:7f00:1` counts as 127.0.0.1. Anything that isn't a valid address is unsafe.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family !== 6) return false;
  const bytes = ipv6Bytes(ip);
  if (!bytes) return false;
  const inner = embeddedIPv4(bytes);
  if (inner) return !blocked.check(inner, 'ipv4');
  return !blocked.check(ip.split('%')[0]!, 'ipv6');
}

class PrivateAddressError extends Error {
  constructor(hostname: string) {
    super(`${hostname} resolves to a private or local address`);
    this.name = 'PrivateAddressError';
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (hostname, callback) =>
  dnsLookup(hostname, { all: true, verbatim: true } satisfies LookupAllOptions, (err, addresses) => callback(err, addresses ?? []));

/**
 * A `lookup` for outgoing connections that refuses a host when any address it resolves to is private. Checked when
 * connecting, so a DNS answer that changes between the URL check and the request (DNS rebinding) can't get through.
 */
export function guardedLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback): void => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err, []);
      const usable = addresses.filter((a) => !options.family || options.family === 0 || a.family === Number(String(options.family).replace('IPv', '')));
      if (!usable.length) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), []);
      if (usable.some((a) => !isPublicAddress(a.address))) return callback(new PrivateAddressError(hostname), []);
      if (options.all) return callback(null, usable);
      callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}

/** Connections whose every resolved address is checked at connect time. */
export function safeDispatcher(resolve?: Resolver): Dispatcher {
  return new Agent({ connect: { lookup: guardedLookup(resolve) as never } });
}

const sharedSafeDispatcher = safeDispatcher();

/**
 * SSRF guard for URLs supplied by tenants (knowledge-base URLs, webhook and workflow targets): http(s) only and,
 * unless allowed, no loopback/private/link-local destinations (cloud metadata endpoints included). This early check
 * gives a clear error; `fetchLimited` checks again when it connects.
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
  if (addresses.some(({ address }) => !isPublicAddress(address))) throw badRequest(PRIVATE_URL_MESSAGE);
  return url;
}

/**
 * fetch for tenant-supplied URLs: a timeout, a response size cap, and redirects followed manually so every hop is
 * checked. Unless `allowPrivate`, each hop must pass `assertSafeUrl` and the connection itself re-checks the resolved
 * address (DNS rebinding).
 */
export async function fetchLimited(
  url: string,
  opts: {
    timeoutMs: number;
    maxBytes: number;
    allowPrivate: boolean;
    headers?: Record<string, string>;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: string;
    maxRedirects?: number;
    /** Tests only: the connection-time checker to use instead of the shared one. */
    dispatcher?: Dispatcher;
  },
): Promise<{ status: number; contentType: string; body: Buffer; finalUrl: string }> {
  let current = url;
  let res: Awaited<ReturnType<typeof undiciFetch>> | undefined;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    await assertSafeUrl(current, { allowPrivate: opts.allowPrivate });
    try {
      res = await undiciFetch(current, {
        method: opts.method ?? 'GET',
        body: opts.body,
        headers: { 'user-agent': 'OmniAI/1.0', ...opts.headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        ...(opts.allowPrivate ? {} : { dispatcher: opts.dispatcher ?? sharedSafeDispatcher }),
      });
    } catch (err) {
      if ((err as { cause?: unknown }).cause instanceof PrivateAddressError) throw badRequest(PRIVATE_URL_MESSAGE);
      throw err;
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
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
