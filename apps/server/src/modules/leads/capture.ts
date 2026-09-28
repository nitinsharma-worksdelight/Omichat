import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import type { CustomFieldType } from '../../db/schema';

const emailSchema = z.string().email();

export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return emailSchema.safeParse(value).success ? value : null;
}

/** Returns E.164 (+14165550123) or null when the number isn't plausibly valid. */
export function normalizePhone(raw: string, defaultCountry = 'US'): string | null {
  const parsed = parsePhoneNumberFromString(raw.trim(), defaultCountry.toUpperCase() as CountryCode);
  return parsed?.isValid() ? parsed.number : null;
}

export function splitName(full: string): { firstName: string; lastName: string | null } {
  const parts = full.trim().replace(/\s+/g, ' ').split(' ');
  const firstName = parts.shift() ?? '';
  return { firstName, lastName: parts.length ? parts.join(' ') : null };
}

/** What a model or a form writes when a detail isn't known: never a real value. */
const PLACEHOLDERS = new Set([
  'unknown',
  'not known',
  'n/a',
  'none',
  'null',
  'undefined',
  'not given',
  'not given yet',
  'not provided',
  'not specified',
  'not available',
  'not on file',
  'no name',
  'anonymous',
  'tbd',
  'customer',
  'visitor',
  'guest',
  '-',
  '—',
  '?',
]);

/** "unknown", "N/A", "(not given yet)"… — the whole value, ignoring case, brackets, quotes and a final full stop. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().toLowerCase().replace(/^[\s([{"'“‘]+|[\s)\]}"'”’.!]+$/g, ''));
}

export function displayName(c: { firstName: string | null; lastName: string | null }): string | null {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || null;
}

/**
 * Coerces a custom-field value to its declared type. Returns `{ ok: false, error }` with a message
 * the AI can relay ("that doesn't look like a date — could you give it as YYYY-MM-DD?").
 */
export function coerceCustomField(
  def: { type: CustomFieldType; options: string[]; label: string },
  raw: unknown,
  defaultCountry = 'US',
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null || raw === '') return { ok: true, value: null };
  const text = typeof raw === 'string' ? raw.trim() : raw;
  switch (def.type) {
    case 'text':
      return { ok: true, value: String(text).slice(0, 2000) };
    case 'number': {
      const n = typeof text === 'number' ? text : Number(String(text).replace(/[, ]/g, ''));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: `${def.label} must be a number` };
    }
    case 'boolean': {
      if (typeof text === 'boolean') return { ok: true, value: text };
      const s = String(text).toLowerCase();
      if (['yes', 'true', 'y', '1'].includes(s)) return { ok: true, value: true };
      if (['no', 'false', 'n', '0'].includes(s)) return { ok: true, value: false };
      return { ok: false, error: `${def.label} must be yes or no` };
    }
    case 'date': {
      const s = String(text);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return { ok: true, value: s };
      return { ok: false, error: `${def.label} must be a date in YYYY-MM-DD format` };
    }
    case 'select': {
      const match = def.options.find((o) => o.toLowerCase() === String(text).toLowerCase());
      return match
        ? { ok: true, value: match }
        : { ok: false, error: `${def.label} must be one of: ${def.options.join(', ')}` };
    }
    case 'email': {
      const email = normalizeEmail(String(text));
      return email ? { ok: true, value: email } : { ok: false, error: `${def.label} must be a valid email` };
    }
    case 'phone': {
      const phone = normalizePhone(String(text), defaultCountry);
      return phone ? { ok: true, value: phone } : { ok: false, error: `${def.label} must be a valid phone number` };
    }
    case 'url': {
      try {
        const u = new URL(String(text).startsWith('http') ? String(text) : `https://${String(text)}`);
        return { ok: true, value: u.toString() };
      } catch {
        return { ok: false, error: `${def.label} must be a valid URL` };
      }
    }
  }
}
