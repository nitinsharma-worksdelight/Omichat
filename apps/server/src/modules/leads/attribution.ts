import { createHash } from 'node:crypto';
import type { ConsentPurpose, ConsentState, FirstTouch } from '../../db/schema';

/** Query parameters worth keeping: campaign tags and ad click ids. Anything else in a URL may be personal. */
export const TOUCH_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid'] as const;

const TAG_FIELDS = ['utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'gclid', 'fbclid', 'msclkid'] as const;
const PARAM_OF: Record<(typeof TAG_FIELDS)[number], (typeof TOUCH_PARAMS)[number]> = {
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  utmTerm: 'utm_term',
  utmContent: 'utm_content',
  gclid: 'gclid',
  fbclid: 'fbclid',
  msclkid: 'msclkid',
};
const MAX: Record<keyof FirstTouch, number> = {
  landingPage: 500,
  referrer: 500,
  utmSource: 200,
  utmMedium: 200,
  utmCampaign: 200,
  utmTerm: 200,
  utmContent: 200,
  gclid: 500,
  fbclid: 500,
  msclkid: 500,
  at: 40,
};

function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Origin + path, plus campaign and click-id parameters unless `keepParams` is false. The fragment always goes. */
export function trimPageUrl(raw: unknown, opts: { keepParams?: boolean } = {}): string | undefined {
  const url = parseUrl(raw);
  if (!url) return undefined;
  const kept = new URLSearchParams();
  if (opts.keepParams !== false) {
    for (const [key, value] of url.searchParams) if ((TOUCH_PARAMS as readonly string[]).includes(key)) kept.append(key, value);
  }
  const query = kept.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`.slice(0, 2000);
}

/**
 * A first touch as the widget or an integration reported it: known fields only, trimmed, overlong values
 * dropped, URLs without their query strings. Campaign tags missing from the fields are read from the
 * landing page's own parameters. Null when nothing usable is left.
 */
export function normalizeTouch(input: unknown, now = new Date()): FirstTouch | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: FirstTouch = {};
  const put = (key: keyof FirstTouch, value: unknown) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v && v.length <= MAX[key]) out[key] = v;
  };
  put('landingPage', trimPageUrl(raw.landingPage, { keepParams: false }));
  put('referrer', trimPageUrl(raw.referrer, { keepParams: false }));
  const landing = parseUrl(raw.landingPage);
  for (const key of TAG_FIELDS) put(key, typeof raw[key] === 'string' ? raw[key] : landing?.searchParams.get(PARAM_OF[key]));
  if (!Object.keys(out).length) return null;
  // The visit came before the message: keep the reported time unless it's unusable or in the future.
  const reported = typeof raw.at === 'string' ? new Date(raw.at) : null;
  const ok = reported && !Number.isNaN(reported.getTime()) && reported.getUTCFullYear() >= 2000 && reported.getTime() <= now.getTime() + 60_000;
  out.at = (ok ? reported : now).toISOString();
  return out;
}

/** Of two first touches, the earlier one (a touch without a time loses to one with). */
export function earlierTouch(a: FirstTouch | null, b: FirstTouch | null): FirstTouch | null {
  if (!a || !b) return a ?? b;
  if (!a.at) return b.at ? b : a;
  if (!b.at) return a;
  return b.at < a.at ? b : a;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

/** Webhook payloads use snake_case keys. */
export function touchForWebhook(touch: FirstTouch | null) {
  return touch ? Object.fromEntries(Object.entries(touch).map(([k, v]) => [snake(k), v])) : null;
}

export function consentForWebhook(consent: Partial<Record<ConsentPurpose, ConsentState>>) {
  return Object.fromEntries(
    Object.entries(consent).map(([purpose, s]) => [purpose, { granted: s!.granted, at: s!.at, source: s!.source, text_version: s!.textVersion }]),
  );
}

/** A short, stable id for a consent wording: records made against the same text share it. */
export function consentVersion(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
}

const PLAIN_NO = new Set([
  'no',
  'nope',
  'nah',
  'not now',
  'not really',
  'not interested',
  'no way',
  'never',
  "don't",
  'do not',
  'no no',
  'nahi',
  'nahin',
  'नहीं',
  'nein',
  'non',
]);

/**
 * A reply that is nothing but a no ("No thanks", "Nope.", "नहीं"): never recorded as a yes. Only the whole
 * reply counts, so "No problem, sign me up!" is not a no; a missed no is still recorded as a decline.
 */
export function isPlainNo(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\b(thanks|thank you|thx|please|sorry|for now)$/u, '')
    .trim();
  return PLAIN_NO.has(t);
}
