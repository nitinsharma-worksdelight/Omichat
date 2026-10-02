/**
 * The demo page for testers: a stand-in website with the chat bubble, opened as /demo?key=pk_… on the API's own
 * address. It used to live next to the dashboard, where the login token is kept; here no login is kept, and the
 * page's policy lets it run only this address's own scripts and talk only to this API.
 */

/** Sent with the page and its script. Styles stay inline: the widget adds its own <style> element. */
export const DEMO_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  // The page's address carries the chat key: never pass it on to other sites.
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-cache',
} as const;

export const DEMO_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Chat demo</title>
    <style>
      :root {
        color-scheme: light;
        --brand: #4f46e5;
        --bg: #f8fafc;
        --surface: #ffffff;
        --fg: #0f172a;
        --muted: #64748b;
        --line: #e2e8f0;
        --error-bg: #fef2f2;
        --error-fg: #b91c1c;
        --error-line: #fecaca;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --bg: #0b1120;
          --surface: #0f172a;
          --fg: #e2e8f0;
          --muted: #94a3b8;
          --line: #1f2a3d;
          --error-bg: rgb(239 68 68 / 0.12);
          --error-fg: #fca5a5;
          --error-line: rgb(239 68 68 / 0.35);
        }
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
      .wrap { max-width: 880px; margin: 0 auto; padding: 0 16px; }
      header { background: var(--surface); border-bottom: 1px solid var(--line); }
      .bar { display: flex; align-items: center; gap: 12px; min-height: 64px; }
      .logo { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; flex: none; border-radius: 10px; background: var(--brand); color: #fff; font-size: 14px; font-weight: 700; }
      .site { min-width: 0; overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
      .badge { flex: none; margin-left: auto; padding: 2px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; font-weight: 600; }
      main { padding: 56px 0 120px; }
      h1 { margin: 0 0 12px; font-size: clamp(28px, 6vw, 40px); line-height: 1.15; letter-spacing: -0.02em; }
      .lead { max-width: 580px; margin: 0 0 24px; color: var(--muted); font-size: 18px; }
      .status { display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 8px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); font-size: 14px; font-weight: 500; }
      .status::before { content: ''; width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--muted); }
      .status.ready::before { background: #16a34a; }
      .status.error { border-color: var(--error-line); background: var(--error-bg); color: var(--error-fg); }
      .status.error::before { background: currentColor; }
      .steps { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 40px 0 0; padding: 0; list-style: none; }
      .steps li { padding: 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--muted); font-size: 15px; }
      .steps strong { display: block; margin-bottom: 2px; color: var(--fg); }
      footer { padding: 24px 0 40px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
    </style>
    <script src="/demo.js" defer></script>
  </head>
  <body>
    <header>
      <div class="wrap bar">
        <span class="logo" id="logo" aria-hidden="true"></span>
        <span class="site" id="site">Chat demo</span>
        <span class="badge">Demo page</span>
      </div>
    </header>
    <main>
      <div class="wrap">
        <h1 id="title">Try the chat assistant</h1>
        <p class="lead">This page stands in for a website so you can test the chat. It isn't a real website.</p>
        <p class="status" id="status" role="status">Loading the chat…</p>
        <ul class="steps">
          <li><strong>1. Open the chat</strong>Click the chat bubble in the bottom corner.</li>
          <li><strong>2. Chat like a visitor</strong>Ask the questions a customer would ask.</li>
          <li><strong>3. Use made-up details</strong>If it asks for a name, email or phone, use test ones.</li>
        </ul>
      </div>
    </main>
    <footer>
      <div class="wrap">A demo page for testing the chat. Conversations here are saved like any other website chat.</div>
    </footer>
  </body>
</html>
`;

/** The page's script: the business's name and colour from the chat's public settings, then the chat bubble. */
export const DEMO_JS = String.raw`(function () {
  // The page is served by the API it talks to; no other API can be chosen.
  var api = location.origin;
  var key = (new URLSearchParams(location.search).get('key') || '').trim();
  var status = document.getElementById('status');

  function show(text, kind) {
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  }
  // Up to two initials, as the chat shows them: "Bright Smile Dental" → "BS".
  function initials(name) {
    return name
      .split(/\s+/)
      .map(function (word) { var m = /[\p{L}\p{N}]/u.exec(word); return m ? m[0] : ''; })
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }

  if (!key) {
    show('This demo link is missing its chat key. Ask for the full link: it ends with ?key=pk_…', 'error');
    return;
  }

  fetch(api + '/widget/v1/config?key=' + encodeURIComponent(key))
    .then(function (res) {
      if (!res.ok) throw new Error(res.status === 404 ? 'unavailable' : 'failed');
      return res.json();
    })
    .then(function (config) {
      var theme = config.theme || {};
      var site = config.companyName || theme.title || 'Chat demo';
      if (/^#[0-9a-f]{3,8}$/i.test(theme.primaryColor || '')) document.documentElement.style.setProperty('--brand', theme.primaryColor);
      document.title = site + ' · Chat demo';
      document.getElementById('site').textContent = site;
      document.getElementById('logo').textContent = initials(site);
      if (config.companyName) document.getElementById('title').textContent = 'Welcome to ' + config.companyName;
      show('The chat is ready. Click the bubble in the bottom corner to start.', 'ready');
    })
    .catch(function (err) {
      show(
        err.message === 'unavailable'
          ? "This chat isn't available. The link may be old, or the chat is turned off."
          : "The chat couldn't load. Check your connection, then reload the page.",
        'error'
      );
    });

  var script = document.createElement('script');
  script.src = api + '/widget.js';
  script.dataset.key = key;
  script.async = true;
  document.body.appendChild(script);
})();
`;
