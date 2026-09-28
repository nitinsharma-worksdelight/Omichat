/** A valid IANA timezone in its canonical spelling ("america/toronto" → "America/Toronto"), or null. */
export function canonicalTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
