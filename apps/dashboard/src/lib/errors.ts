/**
 * API errors and how forms show them. No browser APIs here (api.ts re-exports it all), so the server's test suite can
 * test these directly.
 */

export interface ErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[];

  constructor(status: number, code: string, message: string, details: ErrorDetail[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeDetails(raw: unknown): ErrorDetail[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => {
    if (typeof d === 'string') return { path: '', message: d };
    const o = (d ?? {}) as { path?: unknown; message?: unknown };
    return { path: typeof o.path === 'string' ? o.path : '', message: String(o.message ?? '') };
  });
}

/** A field path in plain words: "expectedCloseOn" → "Expected close on", "business.email" → "Email". */
export function fieldLabel(path: string): string {
  const last = path.split('.').filter((p) => p && !/^\d+$/.test(p)).at(-1) ?? '';
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
}

/** Human-readable message for any thrown value, including validation details. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details.length) {
      const first = err.details
        .slice(0, 3)
        .map((d) => (d.path && d.path !== 'config' ? `${fieldLabel(d.path)}: ${d.message}` : d.message))
        .join('; ');
      const more = err.details.length > 3 ? ` (+${err.details.length - 3} more)` : '';
      // The generic "Request validation failed" adds nothing once the fields say what's wrong.
      return err.code === 'validation_error' ? `${first}${more}` : `${err.message} — ${first}${more}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

/** A request's field errors by path ("value" → "Can't be negative"), so a form can show each next to its field. */
export function fieldErrors(err: unknown, prefix = ''): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details) {
    if (!d.path.startsWith(prefix)) continue;
    const key = d.path.slice(prefix.length);
    if (key && !(key in out)) out[key] = d.message;
  }
  return out;
}
