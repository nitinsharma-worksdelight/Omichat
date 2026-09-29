import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, createOrg, createTestEnv, type TestEnv } from './helpers';

/**
 * The website chat's setup: the embed code points at the address the API is reached at (or PUBLIC_API_URL when it's
 * set), so it's right locally, on staging and in production without configuration; and the chat bubble can be made
 * draggable, off unless the business turns it on.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
type Channel = { id: string; channel: string; publicKey: string; embedSnippet: string | null };

async function webchat(env: TestEnv, org: Org, headers: Record<string, string> = {}): Promise<Channel> {
  const res = await env.app.inject({ method: 'GET', url: '/v1/channels', headers: { ...authHeaders(org.token), ...headers } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as Channel[]).find((c) => c.channel === 'webchat')!;
}

describe('the embed code', () => {
  it('points at the address the API was reached at', async () => {
    const org = await createOrg(t.c, 'Embed Clinic');
    const prod = await webchat(t, org, { host: 'api.acme.test', 'x-forwarded-proto': 'https' });
    expect(prod.embedSnippet).toBe(`<script src="https://api.acme.test/widget.js" data-key="${prod.publicKey}" async></script>`);
    expect((await webchat(t, org, { host: 'localhost:4000' })).embedSnippet).toContain('src="http://localhost:4000/widget.js"');

    // Every channel response carries it: editing, and rotating the key.
    const headers = { ...authHeaders(org.token), host: 'staging.acme.test', 'x-forwarded-proto': 'https' };
    const edited = await t.app.inject({ method: 'PATCH', url: `/v1/channels/${prod.id}`, headers, payload: { name: 'Site chat' } });
    expect((edited.json() as Channel).embedSnippet).toContain('src="https://staging.acme.test/widget.js"');
    const rotated = (await t.app.inject({ method: 'POST', url: `/v1/channels/${prod.id}/rotate-key`, headers })).json() as Channel;
    expect(rotated.embedSnippet).toBe(`<script src="https://staging.acme.test/widget.js" data-key="${rotated.publicKey}" async></script>`);
  });

  it('uses PUBLIC_API_URL when it is set, whatever address the request came in on', async () => {
    const env = await createTestEnv({ env: { PUBLIC_API_URL: 'https://api.brand.com/' } });
    try {
      const org = await createOrg(env.c, 'Brand Clinic');
      const channel = await webchat(env, org, { host: 'omichat-api.onrender.com', 'x-forwarded-proto': 'https' });
      expect(channel.embedSnippet).toBe(`<script src="https://api.brand.com/widget.js" data-key="${channel.publicKey}" async></script>`);
    } finally {
      await env.close();
    }
  });
});

describe('the draggable bubble', () => {
  it('is off unless the business turns it on, and keeps the other appearance settings', async () => {
    const org = await createOrg(t.c, 'Drag Clinic');
    const channel = await webchat(t, org);
    const theme = async () =>
      ((await t.app.inject({ method: 'GET', url: `/widget/v1/config?key=${channel.publicKey}` })).json() as { theme: Record<string, unknown> }).theme;
    const setTheme = (patch: Record<string, unknown>) =>
      t.app.inject({ method: 'PATCH', url: `/v1/channels/${channel.id}`, headers: authHeaders(org.token), payload: { config: { theme: patch } } });

    expect((await theme()).draggable).toBeUndefined();
    expect((await setTheme({ position: 'left', draggable: true })).statusCode).toBe(200);
    expect(await theme()).toMatchObject({ position: 'left', draggable: true });
    expect((await setTheme({ draggable: false })).statusCode).toBe(200);
    expect(await theme()).toMatchObject({ position: 'left', draggable: false });
    expect((await setTheme({ draggable: 'yes' })).statusCode).toBe(400);
  });
});
