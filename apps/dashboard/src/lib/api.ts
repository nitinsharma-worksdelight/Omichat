/**
 * Thin fetch wrapper for the Omni API: base URL, bearer token, org header, JSON errors.
 * Errors from the server look like `{ error: { code, message, details? } }`.
 */

export const API_URL = String(import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/+$/, '');

const TOKEN_KEY = 'omni.dashboard.token';
const ORG_KEY = 'omni.dashboard.orgId';

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the in-memory copy still works.
  }
}

// In-memory copies so the app keeps working for this tab even when storage throws.
let token: string | null = readStorage(TOKEN_KEY);
let orgId: string | null = readStorage(ORG_KEY);

export const session = {
  getToken: () => token,
  setToken(value: string | null) {
    token = value;
    writeStorage(TOKEN_KEY, value);
  },
  getOrgId: () => orgId,
  setOrgId(value: string | null) {
    orgId = value;
    writeStorage(ORG_KEY, value);
  },
  clear() {
    this.setToken(null);
    this.setOrgId(null);
  },
};

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

function normalizeDetails(raw: unknown): ErrorDetail[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => {
    if (typeof d === 'string') return { path: '', message: d };
    const o = (d ?? {}) as { path?: unknown; message?: unknown };
    return { path: typeof o.path === 'string' ? o.path : '', message: String(o.message ?? '') };
  });
}

/** Human-readable message for any thrown value, including validation details. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details.length) {
      const first = err.details
        .slice(0, 3)
        .map((d) => (d.path && d.path !== 'config' ? `${d.path}: ${d.message}` : d.message))
        .join('; ');
      return `${err.message} — ${first}${err.details.length > 3 ? ` (+${err.details.length - 3} more)` : ''}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

const unauthorizedListeners = new Set<() => void>();

/** Called when the dashboard session is rejected (401): the app clears it and shows the login page. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export function handleUnauthorized(): void {
  session.setToken(null);
  for (const fn of unauthorizedListeners) fn();
}

/** Headers for dashboard (JWT) calls. */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const t = session.getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const o = session.getOrgId();
  if (o) headers['x-org-id'] = o;
  return headers;
}

export type QueryValue = string | number | boolean | null | undefined;

/**
 * Builds a URL with query params. `false`, `null`, `undefined` and `''` are left out on purpose:
 * the server coerces boolean query params with `z.coerce.boolean()`, which reads the string
 * "false" as true — so a boolean filter is only ever sent when it is on.
 */
export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.startsWith('http') ? path : `${API_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '' || value === false) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** Replace the dashboard credentials (used for widget/playground tokens). */
  headers?: Record<string, string>;
  /** `false` = don't send the dashboard JWT and don't log out on 401. */
  auth?: boolean;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const useAuth = opts.auth !== false;
  const headers: Record<string, string> = { ...(useAuth ? authHeaders() : {}), ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const method = opts.method ?? (body !== undefined ? 'POST' : 'GET');

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method, headers, body, signal: opts.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', `Can't reach the API at ${API_URL}. Check that the server is running.`);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const e = (data && typeof data === 'object' ? (data as { error?: { code?: string; message?: string; details?: unknown } }).error : undefined) ?? {};
    const error = new ApiError(res.status, e.code ?? 'http_error', e.message ?? `Request failed (HTTP ${res.status})`, normalizeDetails(e.details));
    if (res.status === 401 && useAuth) handleUnauthorized();
    throw error;
  }
  return data as T;
}

export const get = <T>(path: string, query?: Record<string, QueryValue>) => api<T>(path, { query });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = (path: string) => api<void>(path, { method: 'DELETE' });
