/**
 * Checks forms run before saving, so a mistake shows next to its field instead of as a server error. They match the
 * server's rules, which check again. No React or browser APIs here: the server's test suite tests these directly.
 */

// The same pattern the server's email check uses.
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

/** A website as people type it: with or without https://, a dotted host name and no spaces. */
export function isWebsite(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    return (url.protocol === 'https:' || url.protocol === 'http:') && /^[^.]+(\.[^.]+)+$/.test(url.hostname);
  } catch {
    return false;
  }
}

/** A phone number as a business writes it: phone characters only (an extension is fine) and at least 6 digits. */
export function isPhoneLike(value: string): boolean {
  const v = value.trim();
  return /^[+\d()\-.\s/]*(?:(?:ext\.?|x)\s*\d+)?$/i.test(v) && (v.match(/\d/g) ?? []).length >= 6;
}

/** Today's date where the user is, as YYYY-MM-DD (what a date input holds). */
export function todayLocal(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A key as it is saved: lowercase letters, digits and single underscores between words ("Bad Key!" → "bad_key").
 * While someone types, `slugify` keeps a trailing underscore so they can go on to the next word.
 */
export function finalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '');
}
