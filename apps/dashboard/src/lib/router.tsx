import { useEffect, useMemo, useState, type AnchorHTMLAttributes } from 'react';

/** A tiny hash router: `#/bots/123?tab=persona`. */

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  const queryPart = q === -1 ? '' : raw.slice(q + 1);
  const segments = pathPart.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  return { path: `/${segments.join('/')}`, segments, query: new URLSearchParams(queryPart) };
}

export function currentRoute(): Route {
  return parseHash(window.location.hash);
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return useMemo(() => parseHash(hash), [hash]);
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const hash = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === hash) return;
  if (opts.replace) {
    window.history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}

/** Returns `to` with one query param changed (null removes it). */
export function withQuery(route: Route, changes: Record<string, string | null>): string {
  const q = new URLSearchParams(route.query);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return `${route.path}${s ? `?${s}` : ''}`;
}

/** `/bots/:id` against `/bots/abc` → `{ id: 'abc' }`, otherwise null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    const seg = s[i]!;
    if (part.startsWith(':')) params[part.slice(1)] = seg;
    else if (part !== seg) return null;
  }
  return params;
}

export function Link({ to, ...props }: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return <a href={`#${to.startsWith('/') ? to : `/${to}`}`} {...props} />;
}

/** Maps a server link like `/conversations/<id>` to the dashboard route. */
export function appLink(link: string | null | undefined): string | null {
  if (!link) return null;
  if (/^https?:/.test(link)) return null;
  return link.startsWith('/') ? link : `/${link}`;
}
