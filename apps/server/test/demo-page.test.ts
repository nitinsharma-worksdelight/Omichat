import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeLink } from '../../widget/src/links';
import { createOrg, createTestEnv, type TestEnv } from './helpers';

/**
 * Q2 — the testers' demo page lives on the API's address, not next to the dashboard where the login token is kept.
 * It runs only this address's scripts and talks only to this API.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

const API_ORIGIN = 'https://omichat-api.onrender.com';
const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe('the demo page', () => {
  it('is served with a strict policy and no inline script', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/demo?key=pk_test' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');

    const scripts = res.body.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script src="/demo.js" defer>']);
    expect(res.body).not.toMatch(/<script[^>]*>[^<]+<\/script>/); // nothing inline
  });

  it('has a script that only talks to this API', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/demo.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toContain('var api = location.origin;');
    expect(res.body).not.toContain("get('api')");
    expect(res.body).not.toContain('onrender.com');
    // The initials pattern survives as a regular expression (not a lost backslash).
    expect(res.body).toContain(String.raw`/[\p{L}\p{N}]/u`);
  });

  it("starts a chat when the channel allows the API's address, and is refused otherwise", async () => {
    const org = await createOrg(t.c, 'Demo Clinic');
    const start = () =>
      t.app.inject({ method: 'POST', url: '/widget/v1/sessions', headers: { origin: API_ORIGIN }, payload: { key: org.webchat.publicKey } });

    await t.c.channels.update(org.scope, org.webchat.id, { config: { allowedOrigins: ['https://dashboard.example'] } });
    expect((await start()).statusCode).toBe(403);
    await t.c.channels.update(org.scope, org.webchat.id, { config: { allowedOrigins: [API_ORIGIN] } });
    expect((await start()).statusCode).toBe(200);
  });
});

describe("the dashboard's address", () => {
  it('serves nothing that loads the chat widget', () => {
    const dir = path.resolve(__dirname, '../../dashboard/public');
    for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const content = readFileSync(path.join(file.parentPath, file.name), 'utf8');
      expect(content, file.name).not.toContain('widget.js');
    }
  });

  it('forwards old demo links to the new page, key included', () => {
    const page = readFileSync(path.resolve(__dirname, '../../dashboard/public/demo.html'), 'utf8');
    expect(page).toContain("'https://omichat-api.onrender.com') + '/demo' + location.search");
  });
});

describe('widget source links', () => {
  it('opens only http(s) addresses', () => {
    expect(safeLink('https://example.com/faq')).toBe('https://example.com/faq');
    expect(safeLink('http://example.com/a b')).toBe('http://example.com/a%20b');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink(' JavaScript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeLink('/relative/path')).toBeNull();
    expect(safeLink('')).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});
