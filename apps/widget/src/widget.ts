/**
 * Embeddable chat widget.
 *   <script src="https://api.example.com/widget.js" data-key="pk_…" async></script>
 * Renders in a Shadow DOM (no style clashes with the host page), keeps an anonymous visitor id in
 * localStorage so the conversation survives reloads, and streams replies over SSE read with fetch().
 */

import { clamp, fromSaved, isDrag, parseSaved, placement, toSaved, type Point, type SavedPosition, type Side } from './drag';
import { announcesHandoff, headerLine, type Status } from './handoff';
import { safeLink } from './links';
import { startersToOffer, type Starter } from './starters';

interface Theme {
  primaryColor?: string;
  position?: 'right' | 'left';
  title?: string;
  subtitle?: string;
  avatarUrl?: string;
  launcherText?: string;
  /** Visitors may drag the bubble anywhere while the chat is closed; `position` is where it starts. */
  draggable?: boolean;
}

interface WidgetConfig {
  theme: Theme;
  greeting: string;
  assistantName: string;
  companyName: string;
  /** Conversation starters (enabled ones, in order); absent from older servers. */
  starters?: Starter[];
}

interface PublicMessage {
  id: string;
  role: 'user' | 'assistant' | 'agent';
  content: string;
  createdAt: string;
  sources: Array<{ title: string; url: string }>;
}


const script =
  (document.currentScript as HTMLScriptElement | null) ??
  (document.querySelector('script[data-key][src*="widget.js"]') as HTMLScriptElement | null);

const KEY = script?.dataset.key ?? '';
const API = (script?.dataset.api ?? (script?.src ? new URL(script.src).origin : '')).replace(/\/+$/, '');
const STORE = `omni-chat:${KEY}`;

function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(`${STORE}:${key}`);
    if (value === null) localStorage.removeItem(`${STORE}:${key}`);
    else localStorage.setItem(`${STORE}:${key}`, value);
  } catch {
    // Storage blocked (privacy mode): the chat still works for this page view.
  }
  return null;
}

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Campaign tags and ad click ids: the only URL parameters the widget ever sends. */
const TOUCH_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid'];

/** This page without other query parameters or the fragment, which can hold personal data. */
function pageUrl(): string {
  const kept = new URLSearchParams();
  new URLSearchParams(location.search).forEach((value, key) => {
    if (TOUCH_PARAMS.includes(key)) kept.append(key, value);
  });
  const query = kept.toString();
  return `${location.origin}${location.pathname}${query ? `?${query}` : ''}`.slice(0, 2000);
}

/**
 * Where this visitor first came from, recorded once per site on their first page load, before they ever
 * open the chat: the landing page, the external page that sent them, and campaign tags.
 */
function recordFirstTouch(): void {
  if (store('first_touch')) return;
  const params = new URLSearchParams(location.search);
  const touch: Record<string, string> = { landingPage: `${location.origin}${location.pathname}`, at: new Date().toISOString() };
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && ref.host !== location.host) touch.referrer = `${ref.origin}${ref.pathname}`;
  } catch {
    // An unreadable referrer is simply left out.
  }
  const names: Record<string, string> = {
    utm_source: 'utmSource',
    utm_medium: 'utmMedium',
    utm_campaign: 'utmCampaign',
    utm_term: 'utmTerm',
    utm_content: 'utmContent',
    gclid: 'gclid',
    fbclid: 'fbclid',
    msclkid: 'msclkid',
  };
  for (const [param, field] of Object.entries(names)) {
    const value = params.get(param);
    // The server's limits: longer values are dropped there, so they aren't sent.
    if (value && value.length <= (param.startsWith('utm_') ? 200 : 500)) touch[field] = value;
  }
  store('first_touch', JSON.stringify(touch));
}

function firstTouch(): Record<string, string> | undefined {
  try {
    return JSON.parse(store('first_touch') ?? 'null') ?? undefined;
  } catch {
    return undefined;
  }
}

/** The visitor's timezone (e.g. America/Vancouver), so booking times can be shown in their own time too. */
function timezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.root { --c: #4f46e5;
  --bg: #ffffff; --fg: #14161b; --title: #14161b; --fg-2: #5b6475; --muted: #6b7280; --strong: #3f4654;
  --line: #e3e5ea; --line-soft: #eceef2; --field-line: #dfe2e8; --field-bg: #ffffff; --bubble: #f2f3f6; --chip-bg: #ffffff;
  --online: #16a34a; --err-bg: #fef2f2; --err-line: #fde0e0; --err-fg: #b91c1c;
  /* Tints of the bot's colour; neutral stand-ins where color-mix() isn't supported. */
  --accent-text: var(--c); --avatar-fg: var(--c); --accent-line: var(--c);
  --accent-soft: #eef0f4; --accent-pill: #eef0f4; --accent-hover: #f2f3f6; --accent-ring: rgba(15, 23, 42, .12);
  --accent-shadow: rgba(15, 23, 42, .28); --accent-shadow-strong: rgba(15, 23, 42, .32); --drag-ring: rgba(15, 23, 42, .12);
  --panel-shadow: 0 0 0 1px rgba(15, 23, 42, .06), 0 12px 28px -6px rgba(15, 23, 42, .16), 0 32px 64px -24px rgba(15, 23, 42, .24);
  --launcher-shadow: 0 10px 24px -6px var(--accent-shadow), 0 2px 6px rgba(15, 23, 42, .14);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", system-ui, Roboto, sans-serif;
  -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; color-scheme: light dark; color: var(--fg);
  position: fixed; bottom: 20px; z-index: 2147483000; }
@supports (color: color-mix(in srgb, red 50%, blue)) {
  .root { --accent-line: color-mix(in srgb, var(--c) 32%, transparent); --accent-soft: color-mix(in srgb, var(--c) 12%, transparent);
    --accent-pill: color-mix(in srgb, var(--c) 10%, transparent); --accent-hover: color-mix(in srgb, var(--c) 6%, transparent);
    --accent-ring: color-mix(in srgb, var(--c) 16%, transparent); --accent-shadow: color-mix(in srgb, var(--c) 45%, transparent);
    --accent-shadow-strong: color-mix(in srgb, var(--c) 55%, transparent); --drag-ring: color-mix(in srgb, var(--c) 18%, transparent); }
}
@media (prefers-color-scheme: dark) {
  .root { --bg: #121418; --fg: #e8eaef; --title: #eef0f4; --fg-2: #a1a9b7; --muted: #8f98a8; --strong: #c9ced8;
    --line: #2b2f38; --line-soft: #23262e; --field-line: #2b2f38; --field-bg: #1a1d23; --bubble: #1e2129; --chip-bg: transparent;
    --online: #22c55e; --err-bg: rgba(239, 68, 68, .12); --err-line: rgba(239, 68, 68, .3); --err-fg: #fca5a5;
    --accent-text: var(--fg); --avatar-fg: var(--fg); --accent-soft: #2b2f38; --accent-pill: #2b2f38;
    --panel-shadow: 0 0 0 1px rgba(255, 255, 255, .07), 0 16px 32px -8px rgba(0, 0, 0, .5), 0 32px 64px -24px rgba(0, 0, 0, .6);
    --launcher-shadow: 0 10px 24px -6px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .08); }
  @supports (color: color-mix(in srgb, red 50%, blue)) {
    /* Lighter shades of the bot's colour, readable on the dark surface. */
    .root { --accent-text: color-mix(in srgb, var(--c) 45%, #fff); --avatar-fg: color-mix(in srgb, var(--c) 40%, #fff);
      --accent-line: color-mix(in srgb, color-mix(in srgb, var(--c) 70%, #fff) 50%, transparent);
      --accent-soft: color-mix(in srgb, var(--c) 24%, transparent); --accent-pill: color-mix(in srgb, var(--c) 24%, transparent);
      --accent-hover: color-mix(in srgb, var(--c) 14%, transparent); }
  }
}
.root.right { right: 20px; } .root.left { left: 20px; }
.root:not(.ready) { visibility: hidden; }
button { font: inherit; }
.launcher { position: relative; display: flex; align-items: center; justify-content: center; gap: 8px; height: 56px; min-width: 56px;
  padding: 0 22px 0 18px; border: 0; border-radius: 28px; background: var(--c); color: #fff; cursor: pointer;
  font-size: 15px; font-weight: 600; line-height: 20px; white-space: nowrap;
  box-shadow: var(--launcher-shadow); transition: transform .15s, box-shadow .15s; }
.launcher.icon-only { width: 56px; padding: 0; }
.launcher svg { width: 22px; height: 22px; flex: none; }
.launcher.icon-only .i-chat { width: 26px; height: 26px; }
.launcher.icon-only .i-open { width: 24px; height: 24px; }
.launcher .i-open, .root.open .launcher .i-chat { display: none; }
.root.open .launcher .i-open { display: block; }
.root.moved.below .launcher .i-open, .root.moved.below .head .x svg { transform: rotate(180deg); }
.launcher:focus-visible { outline: none; box-shadow: 0 0 0 3px #fff, 0 0 0 5px var(--c), var(--launcher-shadow); }
.launcher.draggable { touch-action: none; -webkit-user-select: none; user-select: none; cursor: grab; }
.root.dragging .launcher { cursor: grabbing; transform: none; transition: none;
  box-shadow: 0 0 0 6px var(--drag-ring), 0 22px 40px -10px var(--accent-shadow-strong), 0 4px 10px rgba(15, 23, 42, .18); }
@media (hover: hover) {
  .launcher:hover { box-shadow: 0 16px 32px -8px var(--accent-shadow), 0 3px 8px rgba(15, 23, 42, .16); }
  .launcher:not(.draggable):hover { transform: translateY(-2px); }
  /* A tip to find out the bubble can be moved; once it has been, it's no longer needed. */
  .launcher.draggable::after { content: 'Drag to move'; position: absolute; bottom: calc(100% + 12px); padding: 6px 10px;
    border-radius: 8px; background: #14161b; color: #fff; font-size: 12px; font-weight: 500; line-height: 16px; white-space: nowrap;
    pointer-events: none; opacity: 0; transition: opacity .15s; }
  .root.right .launcher.draggable::after { right: 0; } .root.left .launcher.draggable::after { left: 0; }
  .root:not(.moved):not(.open):not(.dragging) .launcher.draggable:hover::after { opacity: 1; transition-delay: .3s; }
}
.panel { position: absolute; bottom: 72px; width: 380px; height: min(640px, calc(100vh - 110px)); display: none;
  flex-direction: column; background: var(--bg); border-radius: 20px; overflow: hidden; box-shadow: var(--panel-shadow);
  transform-origin: calc(100% - 28px) calc(100% + 44px); }
.root.right .panel { right: 0; } .root.left .panel { left: 0; transform-origin: 28px calc(100% + 44px); }
.root.open .panel { display: flex; }
/* Opened by the visitor, the window scales in from the bubble. */
.root.anim.open .panel { animation: pop .2s cubic-bezier(.2, .9, .3, 1); }
@keyframes pop { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
.head { display: flex; align-items: center; gap: 12px; padding: 14px 12px 14px 16px; background: var(--bg); border-bottom: 1px solid var(--line-soft); }
.face { position: relative; width: 40px; height: 40px; flex: none; }
.face .av { width: 40px; height: 40px; font-size: 14px; letter-spacing: .02em; }
.face .dot { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border-radius: 50%; background: var(--online); border: 2px solid var(--bg); }
.titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.head .t { font-size: 15px; font-weight: 600; line-height: 20px; letter-spacing: -.01em; color: var(--title); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head .s { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12.5px; line-height: 18px; color: var(--fg-2); }
.head .s span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai { flex: none; padding: 0 6px; border-radius: 999px; background: var(--accent-pill); color: var(--accent-text); font-size: 10px; font-weight: 700; letter-spacing: .06em; line-height: 16px; }
.head .x { flex: none; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border: 0; border-radius: 12px; background: transparent; color: var(--fg-2); cursor: pointer; }
.head .x svg { width: 20px; height: 20px; transition: transform .15s; }
.log { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 16px 12px; display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; }
.day { align-self: center; font-size: 11.5px; font-weight: 500; line-height: 16px; color: var(--muted); }
.row { display: flex; align-items: flex-end; gap: 8px; }
.row.me { justify-content: flex-end; }
.av { width: 28px; height: 28px; flex: none; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 50%;
  background: var(--accent-soft); color: var(--avatar-fg); font-size: 10.5px; font-weight: 600; }
.av img { width: 100%; height: 100%; object-fit: cover; }
.row .av { margin-bottom: 20px; }
.av.person { background: var(--line-soft); color: var(--strong); }
.av.person svg { width: 14px; height: 14px; }
.col { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; max-width: 280px; }
.row.me .col { align-items: flex-end; }
.label { padding-left: 4px; font-size: 12px; font-weight: 600; line-height: 16px; color: var(--strong); }
.msg { max-width: 100%; padding: 10px 14px; border-radius: 18px 18px 18px 6px; font-size: 14.5px; line-height: 21px; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg a { color: inherit; text-decoration: underline; }
.msg.assistant { background: var(--bubble); color: var(--fg); }
.msg.agent { background: var(--bg); color: var(--fg); border: 1px solid var(--line); }
.msg.user { background: var(--c); color: #fff; border-radius: 18px 18px 6px 18px; }
.meta { padding: 0 4px; font-size: 11.5px; line-height: 16px; color: var(--muted); }
.sources { display: flex; flex-wrap: wrap; gap: 6px; max-width: 100%; margin-top: 2px; }
.sources a { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 26px; padding: 0 10px; border: 1px solid var(--line);
  border-radius: 13px; background: var(--chip-bg); color: var(--strong); font-size: 12px; font-weight: 500; text-decoration: none; }
.sources a svg { width: 12px; height: 12px; flex: none; }
.sources a span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notice { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 12px; font-weight: 500; line-height: 16px; color: var(--fg-2); }
.notice::before, .notice::after { content: ''; flex: 1; height: 1px; background: var(--line-soft); }
.notice svg { width: 14px; height: 14px; flex: none; margin-right: -4px; }
.starters { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; padding-left: 36px; margin-top: 4px; }
.starter { max-width: 100%; min-height: 36px; padding: 7px 14px; border: 1px solid var(--accent-line); border-radius: 18px;
  background: var(--chip-bg); color: var(--accent-text); font-size: 13.5px; font-weight: 500; line-height: 20px; text-align: right;
  cursor: pointer; overflow-wrap: anywhere; transition: background-color .15s, border-color .15s; }
.starter:focus-visible, .send:focus-visible, .head .x:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
.starter:disabled { opacity: .55; cursor: default; }
@media (pointer: coarse) { .starter { min-height: 44px; } }
@media (hover: hover) {
  .starter:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--c); }
  .head .x:hover { background: var(--bubble); color: var(--fg); }
  .sources a:hover { border-color: var(--fg-2); color: var(--fg); }
}
.status { display: flex; align-items: center; gap: 8px; padding: 0 16px 12px; }
.status:empty { display: none; }
.dots { display: flex; align-items: center; gap: 4px; height: 38px; padding: 0 14px; border-radius: 18px 18px 18px 6px; background: var(--bubble); }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: b 1.2s infinite; }
.dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
@keyframes b { 0%, 60%, 100% { opacity: .35; transform: none; } 30% { opacity: .9; transform: translateY(-2px); } }
.activity { min-width: 0; font-size: 12px; line-height: 16px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.err { display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 8px 12px; border: 1px solid var(--err-line); border-radius: 12px;
  background: var(--err-bg); color: var(--err-fg); font-size: 12.5px; font-weight: 500; line-height: 18px; }
.err:empty { display: none; }
.err::before { content: ''; width: 16px; height: 16px; flex: none; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 8v4M12 16h.01'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 8v4M12 16h.01'/%3E%3C/svg%3E") center / contain no-repeat; }
form { display: flex; align-items: flex-end; gap: 8px; margin: 4px 12px 0; padding: 6px 6px 6px 14px; border: 1px solid var(--field-line);
  border-radius: 16px; background: var(--field-bg); box-shadow: 0 1px 2px rgba(15, 23, 42, .05); transition: border-color .15s, box-shadow .15s; }
form:focus-within { border-color: var(--c); box-shadow: 0 0 0 3px var(--accent-ring); }
textarea { flex: 1; min-width: 0; height: 40px; min-height: 40px; max-height: 120px; padding: 10px 0; border: 0; outline: none; resize: none;
  background: transparent; color: var(--fg); font: inherit; font-size: 14.5px; line-height: 20px; }
textarea::placeholder { color: var(--muted); opacity: 1; }
.send { flex: none; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border: 0; border-radius: 12px;
  background: var(--c); color: #fff; cursor: pointer; }
.send svg { width: 18px; height: 18px; }
.send:disabled { opacity: .5; cursor: default; }
.brand { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 10px 16px 12px; text-align: center;
  font-size: 11px; line-height: 16px; color: var(--muted); }
.bn { font-weight: 600; color: var(--strong); white-space: nowrap; }
.bn svg { width: 12px; height: 12px; margin-right: 3px; vertical-align: -2px; }
.root.moved { left: var(--x); top: var(--y); right: auto; bottom: auto; }
.root.moved .panel { left: var(--panel-x, 0px); right: auto; height: var(--panel-h, min(640px, calc(100vh - 110px)));
  transform-origin: calc(28px - var(--panel-x, 0px)) calc(100% + 44px); }
.root.moved.below .panel { top: 72px; bottom: auto; transform-origin: calc(28px - var(--panel-x, 0px)) -44px; }
@media (max-width: 480px) {
  .root.open, .root.open.moved { inset: 0; }
  .root.open .panel, .root.open.moved .panel { position: fixed; inset: 0; width: 100%; height: 100%; border-radius: 0; bottom: 0;
    box-shadow: none; transform-origin: 50% 100%; }
  .root.open .launcher { display: none; }
  .head { padding: 12px 8px 12px 16px; }
  .head .t { font-size: 16px; line-height: 21px; }
  .head .s { font-size: 13px; }
  .head .x { width: 44px; height: 44px; }
  .head .x svg { width: 22px; height: 22px; }
  .col { max-width: 290px; }
  .msg { padding: 11px 15px; font-size: 15px; line-height: 22px; }
  .meta { font-size: 12px; }
  .starter { min-height: 44px; padding: 10px 16px; border-radius: 22px; font-size: 14.5px; }
  form { margin: 8px 12px 0; padding: 6px 6px 6px 16px; border-radius: 18px; }
  textarea { height: 44px; min-height: 44px; padding: 12px 0; font-size: 16px; }
  .send { width: 44px; height: 44px; border-radius: 14px; }
  .send svg { width: 20px; height: 20px; }
  .brand { padding-bottom: max(28px, env(safe-area-inset-bottom)); font-size: 11.5px; }
}
@media (prefers-reduced-motion: reduce) {
  .dots i, .root.anim.open .panel { animation: none; }
  .launcher, .starter, form, .head .x svg { transition: none; }
  .launcher:not(.draggable):hover { transform: none; }
}
`;

const ICON_CHAT =
  '<svg class="i-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
const ICON_CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
/** The bubble's icons: a chat bubble while closed, a chevron towards the bubble while open. */
const LAUNCHER_ICONS = `${ICON_CHAT}${ICON_CHEVRON.replace('<svg ', '<svg class="i-open" ')}`;
const ICON_SEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
const ICON_DOC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
const ICON_PERSON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>';
const ICON_MAGNET =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4v8a7 7 0 0 0 14 0V4h-5v8a2 2 0 0 1-4 0V4Z"/><path d="M5 8h5"/><path d="M14 8h5"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Plain text with clickable links; never injects HTML from messages. */
function renderText(target: HTMLElement, text: string) {
  target.textContent = '';
  const parts = text.split(/(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)])/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const a = el('a', undefined, part);
      a.href = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      target.appendChild(a);
    } else if (part) {
      target.appendChild(document.createTextNode(part.replace(/\*\*(.+?)\*\*/g, '$1')));
    }
  });
}

/** Up to two initials for a picture-less avatar: "Bright Smile Dental" → "BS". */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** A message's time in the visitor's own format, e.g. "2:14 PM". */
function timeOf(at: Date): string {
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The label over a day's messages: "Today", "Yesterday" or the date. */
function dayOf(at: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) return 'Today';
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return at.toLocaleDateString([], { day: 'numeric', month: 'short', ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}

function viewport() {
  return { width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight };
}

class ChatWidget {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly statusLine: HTMLDivElement;
  private readonly errorLine: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly launcher: HTMLButtonElement;

  private config: WidgetConfig | null = null;
  private token: string | null = null;
  private visitorId: string | null = store('visitor');
  private conversationId: string | null = null;
  private status: Status = null;
  /** The chat has loaded (history and status): a change of status from here on is news to the visitor. */
  private ready = false;
  /** A team member has replied since the chat passed to the team. */
  private teamReplied = false;
  private subtitle!: HTMLElement;
  private aiChip!: HTMLElement;
  private usualSubtitle = 'We typically reply in seconds';
  private readonly rendered = new Set<string>();
  private lastMessageId: string | null = null;
  private streamingBubble: HTMLDivElement | null = null;
  private streamAbort: AbortController | null = null;
  private reconnectDelay = 1000;
  private sessionPromise: Promise<void> | null = null;
  private sending = false;
  /** The messages the session started with (null until it has): the greeting and starters wait for it and the settings. */
  private sessionMessages: PublicMessage[] | null = null;
  private introShown = false;
  /** The conversation starters on show; removed once the visitor has written. */
  private starters: HTMLDivElement | null = null;
  /** Each starter's message id for its latest attempt: a retry after an unclear failure can't send it twice. */
  private readonly starterAttempts = new Map<string, string>();
  /** The day of the last message shown, for the "Today" (or date) label over each day's first message. */
  private lastDay: string | null = null;

  /** The side the business chose for the bubble (where it starts). */
  private side: Side = 'right';
  /** Set once the configuration allows dragging. */
  private draggable = false;
  /** Where a visitor moved the bubble (its top-left corner), and that spot as remembered on this site. */
  private moved: Point | null = null;
  private saved: SavedPosition | null = null;
  /** The press in progress on the bubble; it becomes a drag once it moves far enough. */
  private press: { id: number; x: number; y: number; left: number; top: number; type: string; dragging: boolean } | null = null;
  /** The click the browser sends when a drag is released: it isn't a request to open the chat. */
  private swallowClick = false;
  /** The chat opened (e.g. restored as open) before the widget could be shown: focus its input once it's shown. */
  private focusWhenReady = false;

  constructor() {
    const host = el('div');
    host.setAttribute('data-omni-chat', '');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = STYLES;
    shadow.appendChild(style);

    this.root = el('div', 'root right');
    this.panel = el('div', 'panel');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Chat');

    const head = el('div', 'head');
    const face = el('div', 'face');
    face.append(this.botFace(), el('span', 'dot'));
    const titles = el('div', 'titles');
    const title = el('div', 't', 'Chat with us');
    const byline = el('div', 's');
    const subtitle = el('span', undefined, this.usualSubtitle);
    this.subtitle = subtitle;
    this.aiChip = el('span', 'ai', 'AI');
    byline.append(this.aiChip, subtitle);
    titles.append(title, byline);
    const close = el('button', 'x');
    close.type = 'button';
    close.innerHTML = ICON_CHEVRON;
    close.setAttribute('aria-label', 'Minimize chat');
    close.addEventListener('click', () => this.toggle(false));
    head.append(face, titles, close);

    this.log = el('div', 'log');
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.statusLine = el('div', 'status');
    this.errorLine = el('div', 'err');
    this.errorLine.setAttribute('role', 'alert');

    const form = el('form');
    this.input = el('textarea');
    this.input.rows = 1;
    this.input.placeholder = 'Write a message…';
    this.input.setAttribute('aria-label', 'Message');
    this.input.maxLength = 4000;
    this.sendBtn = el('button', 'send');
    this.sendBtn.type = 'submit';
    this.sendBtn.innerHTML = ICON_SEND;
    this.sendBtn.setAttribute('aria-label', 'Send');
    form.append(this.input, this.sendBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
    });

    const brand = el('div', 'brand');
    const poweredBy = el('div', undefined, 'Powered by ');
    const brandName = el('span', 'bn');
    brandName.innerHTML = ICON_MAGNET;
    brandName.append('LeadsMagnet AI');
    poweredBy.append(brandName);
    brand.append(el('div', undefined, 'Chats are recorded so our team can assist you.'), poweredBy);
    this.panel.append(head, this.log, this.statusLine, this.errorLine, form, brand);
    this.launcher = el('button', 'launcher icon-only');
    this.launcher.type = 'button';
    this.launcher.innerHTML = LAUNCHER_ICONS;
    this.launcher.setAttribute('aria-label', 'Open chat');
    this.launcher.addEventListener('click', () => {
      if (this.swallowClick) {
        this.swallowClick = false;
        return;
      }
      this.toggle();
    });
    this.root.append(this.panel, this.launcher);
    shadow.appendChild(this.root);
    document.body.appendChild(host);
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggle(false);
    });

    void this.loadConfig(title, subtitle);
    if (store('open') === '1') this.toggle(true);
  }

  private async loadConfig(title: HTMLElement, subtitle: HTMLElement) {
    try {
      const res = await fetch(`${API}/widget/v1/config?key=${encodeURIComponent(KEY)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.config = (await res.json()) as WidgetConfig;
      const t = this.config.theme;
      if (t.primaryColor) this.root.style.setProperty('--c', t.primaryColor);
      this.side = t.position === 'left' ? 'left' : 'right';
      this.root.classList.toggle('left', this.side === 'left');
      this.root.classList.toggle('right', this.side === 'right');
      title.textContent = this.displayName();
      this.panel.setAttribute('aria-label', `Chat with ${title.textContent}`);
      this.usualSubtitle = t.subtitle || `${this.config.assistantName} · usually replies instantly`;
      this.renderHeader();
      // The pictures and names drawn before the settings arrived (the header, or a chat restored with its history).
      this.root.querySelectorAll<HTMLElement>('.av.bot').forEach((av) => this.fillFace(av));
      this.root.querySelectorAll<HTMLElement>('.meta .name').forEach((name) => {
        name.textContent = `${this.config!.assistantName} · `;
      });
      if (t.launcherText) {
        this.launcher.classList.remove('icon-only');
        this.launcher.innerHTML = `${LAUNCHER_ICONS}<span></span>`;
        this.launcher.querySelector('span')!.textContent = t.launcherText;
        // Its words are its name.
        this.launcher.removeAttribute('aria-label');
      }
      // After the launcher text: the bubble's final size decides where it may go.
      if (t.draggable) this.enableDragging();
      // A chat restored as open may have its session already.
      this.showIntro();
      // Everything above is applied in this same step, so the widget's first visible frame is its final look and place.
      this.root.classList.add('ready');
      if (this.focusWhenReady && this.root.classList.contains('open')) this.input.focus();
      this.focusWhenReady = false;
    } catch {
      this.root.style.display = 'none'; // unknown/disabled key: stay invisible on the host page
    }
  }

  toggle(force?: boolean) {
    const open = force ?? !this.root.classList.contains('open');
    if (open) this.placePanel();
    // Opened by the visitor, the window scales in; a chat restored as the page loads is simply there.
    this.root.classList.toggle('anim', this.root.classList.contains('ready'));
    this.root.classList.toggle('open', open);
    this.launcher.setAttribute('aria-expanded', String(open));
    if (this.launcher.classList.contains('icon-only')) this.launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    store('open', open ? '1' : null);
    if (open) {
      void this.ensureSession().then(() => {
        // A hidden input can't take focus: wait until the widget is shown.
        if (this.root.classList.contains('ready')) this.input.focus();
        else this.focusWhenReady = true;
      });
    }
  }

  /** Visitors may move the bubble anywhere while the chat is closed; the spot they leave it in is remembered here. */
  private enableDragging() {
    this.draggable = true;
    this.launcher.classList.add('draggable');
    this.saved = parseSaved(store('position'), this.side);
    if (this.saved) this.refit();
    this.launcher.addEventListener('pointerdown', (e) => this.pressStart(e));
    this.launcher.addEventListener('pointermove', (e) => this.pressMove(e));
    this.launcher.addEventListener('pointerup', (e) => this.pressEnd(e));
    this.launcher.addEventListener('pointercancel', (e) => this.pressEnd(e));
    // A release the page never saw (e.g. outside the window) still ends the drag.
    this.launcher.addEventListener('lostpointercapture', (e) => this.pressEnd(e));
    window.addEventListener('resize', () => this.refit());
  }

  private pressStart(e: PointerEvent) {
    // Only while the chat is closed, and only a primary press (not a right-click or a second finger).
    if (!this.draggable || this.root.classList.contains('open') || !e.isPrimary || e.button !== 0) return;
    const r = this.launcher.getBoundingClientRect();
    this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, type: e.pointerType, dragging: false };
    // Captured, so a quick drag keeps following the pointer after it leaves the bubble.
    try {
      this.launcher.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer any more (or no capture support): the drag still follows while over the bubble.
    }
  }

  private pressMove(e: PointerEvent) {
    const press = this.press;
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.dragging) {
      if (!isDrag(dx, dy, press.type)) return;
      press.dragging = true;
      this.root.classList.add('dragging');
    }
    this.moveTo(clamp({ x: press.left + dx, y: press.top + dy }, this.bubbleSize(), viewport()));
  }

  private pressEnd(e: PointerEvent) {
    const press = this.press;
    if (!press || e.pointerId !== press.id) return;
    this.press = null;
    if (this.launcher.hasPointerCapture?.(e.pointerId)) this.launcher.releasePointerCapture(e.pointerId);
    if (!press.dragging) return;
    this.root.classList.remove('dragging');
    // A mouse release is followed by a click in the same turn; a touch release by none. Either way it's over after this.
    this.swallowClick = true;
    setTimeout(() => {
      this.swallowClick = false;
    }, 0);
    if (!this.moved) return;
    this.saved = toSaved(this.moved, this.bubbleSize(), viewport(), this.side);
    store('position', JSON.stringify(this.saved));
  }

  private moveTo(p: Point) {
    this.moved = p;
    this.root.classList.add('moved');
    this.root.style.setProperty('--x', `${Math.round(p.x)}px`);
    this.root.style.setProperty('--y', `${Math.round(p.y)}px`);
  }

  /** After a resize or rotation (or on load): the remembered spot, on this screen size. */
  private refit() {
    if (!this.saved && !this.moved) return;
    const size = this.bubbleSize();
    this.moveTo(this.saved ? fromSaved(this.saved, size, viewport()) : clamp(this.moved!, size, viewport()));
    if (this.root.classList.contains('open')) this.placePanel();
  }

  /** The chat window of a moved bubble opens where there's room (the usual spot otherwise). */
  private placePanel() {
    if (!this.moved) return;
    const { below, panelX, height } = placement(this.moved, this.bubbleSize(), viewport());
    this.root.classList.toggle('below', below);
    this.root.style.setProperty('--panel-x', `${Math.round(panelX)}px`);
    this.root.style.setProperty('--panel-h', `${Math.round(height)}px`);
  }

  private bubbleSize() {
    const r = this.launcher.getBoundingClientRect();
    // Hidden (a phone's full-screen chat): its usual size.
    return { width: r.width || 56, height: r.height || 56 };
  }

  private ensureSession(): Promise<void> {
    if (this.token) return Promise.resolve();
    if (!this.sessionPromise) {
      this.sessionPromise = this.startSession().finally(() => {
        this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  }

  private async startSession() {
    try {
      const res = await fetch(`${API}/widget/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: KEY, visitorId: this.visitorId ?? undefined }),
      });
      if (!res.ok) throw new Error(res.status === 403 ? 'This chat is not available on this website.' : 'Chat is unavailable right now.');
      const data = (await res.json()) as { token: string; visitorId: string; conversationId: string | null; status: Status; messages: PublicMessage[] };
      this.token = data.token;
      this.visitorId = data.visitorId;
      store('visitor', data.visitorId);
      this.conversationId = data.conversationId;
      this.setStatus(data.status);
      data.messages.forEach((m) => this.addBubble(m));
      // A chat already with the team (reload or another tab) says so after its history, as it did when it happened.
      if (data.status === 'human_active') this.showHandoffNotice();
      const replies = data.messages.filter((m) => m.role !== 'user');
      this.teamReplied = data.status === 'human_active' && replies.length > 0 && replies[replies.length - 1]!.role === 'agent';
      this.ready = true;
      this.renderHeader();
      this.sessionMessages ??= data.messages;
      this.showIntro();
      this.error('');
      if (this.conversationId) this.openStream();
    } catch (err) {
      this.error((err as Error).message);
      throw err;
    }
  }

  /** The greeting and the conversation starters, once both the settings and the session are in (either may come first). */
  private showIntro() {
    if (this.introShown || !this.config || !this.sessionMessages) return;
    this.introShown = true;
    // Only in a fresh chat: not over earlier messages, nor once the visitor has started writing.
    if (this.sessionMessages.length || this.log.childElementCount) return;
    // A brand-new chat needs no "Today" label.
    this.lastDay = new Date().toDateString();
    if (this.config.greeting) this.addBubble({ id: 'greeting', role: 'assistant', content: this.config.greeting, createdAt: '', sources: [] });
    const starters = startersToOffer(this.config.starters, this.sessionMessages);
    if (starters.length) this.renderStarters(starters);
  }

  private renderStarters(starters: Starter[]) {
    const group = el('div', 'starters');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Suggested questions');
    for (const starter of starters) {
      const button = el('button', 'starter', starter.label);
      button.type = 'button';
      // Pressed with the keyboard (no pointer: detail 0), the message box is next; a tap doesn't pop up a phone's keyboard.
      button.addEventListener('click', (e) => void this.sendStarter(starter, e.detail === 0));
      group.append(button);
    }
    this.log.append(group);
    this.starters = group;
    this.scroll();
  }

  private removeStarters() {
    this.starters?.remove();
    this.starters = null;
  }

  private setStartersDisabled(disabled: boolean) {
    this.starters?.querySelectorAll('button').forEach((b) => {
      b.disabled = disabled;
    });
  }

  private async send() {
    const content = this.input.value.trim();
    if (!content || this.sending) return;
    this.input.value = '';
    this.input.style.height = '';
    await this.post(content, uid());
  }

  /** A click on a conversation starter sends its message as the visitor's; a failed one can be clicked again. */
  private async sendStarter(starter: Starter, fromKeyboard: boolean) {
    if (this.sending) return;
    if (fromKeyboard) this.input.focus();
    // The same id on a retry: if the first try did arrive after all, the server keeps one message.
    const clientMessageId = this.starterAttempts.get(starter.id) ?? uid();
    this.starterAttempts.set(starter.id, clientMessageId);
    await this.post(starter.message, clientMessageId, starter.id);
  }

  /** Sends one visitor message, shown straight away. Starters stay unclickable meanwhile and go once it's in. */
  private async post(content: string, clientMessageId: string, starterId?: string) {
    this.sending = true;
    this.sendBtn.disabled = true;
    this.setStartersDisabled(true);
    const optimistic: PublicMessage = { id: `local-${clientMessageId}`, role: 'user', content, createdAt: new Date().toISOString(), sources: [] };
    const bubble = this.addBubble(optimistic);
    try {
      await this.ensureSession();
      const post = () =>
        fetch(`${API}/widget/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ content, clientMessageId, pageUrl: pageUrl(), firstTouch: firstTouch(), timezone: timezone(), starterId }),
        });
      let res = await post();
      if (res.status === 401) {
        this.token = null;
        await this.ensureSession();
        res = await post();
      }
      if (res.status === 429) throw new Error("You're sending messages quickly — please wait a moment.");
      if (!res.ok) throw new Error('Message not sent. Please try again.');
      const data = (await res.json()) as { conversationId: string; message: PublicMessage };
      this.rendered.add(data.message.id);
      this.track(data.message.id);
      if (this.conversationId !== data.conversationId) {
        this.conversationId = data.conversationId;
        this.openStream();
      }
      if (this.status !== 'human_active') this.showTyping();
      this.error('');
      this.removeStarters();
    } catch (err) {
      this.error((err as Error).message);
      // Unsent: a starter's message comes back off the screen, so the visitor can simply click it again.
      if (starterId) {
        bubble?.remove();
        this.rendered.delete(optimistic.id);
      }
    } finally {
      this.sending = false;
      this.sendBtn.disabled = false;
      this.setStartersDisabled(false);
    }
  }

  private openStream() {
    this.streamAbort?.abort();
    if (!this.conversationId || !this.token) return;
    const abort = new AbortController();
    this.streamAbort = abort;
    const url = `${API}/widget/v1/stream?conversationId=${this.conversationId}`;
    void (async () => {
      try {
        const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, signal: abort.signal });
        if (res.status === 401) {
          this.token = null;
          await this.ensureSession();
          return;
        }
        if (!res.ok || !res.body) throw new Error('stream failed');
        this.reconnectDelay = 1000;
        void this.catchUp();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const event = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (event && data) this.onEvent(event, JSON.parse(data));
          }
        }
      } catch {
        if (abort.signal.aborted) return;
      }
      if (abort.signal.aborted) return;
      // Dropped connection: back off and reconnect, then fill the gap.
      setTimeout(() => {
        if (this.streamAbort === abort) this.openStream();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    })();
  }

  private async catchUp() {
    if (!this.token) return;
    const q = this.lastMessageId && !this.lastMessageId.startsWith('local-') ? `?after=${this.lastMessageId}` : '';
    try {
      const res = await fetch(`${API}/widget/v1/messages${q}`, { headers: { authorization: `Bearer ${this.token}` } });
      if (!res.ok) return;
      const data = (await res.json()) as { status: Status; messages: PublicMessage[] };
      data.messages.forEach((m) => this.addBubble(m));
      if (data.status) this.setStatus(data.status);
    } catch {
      // next reconnect will try again
    }
  }

  private onEvent(event: string, data: Record<string, unknown>) {
    switch (event) {
      case 'ai.typing':
        this.showTyping();
        break;
      case 'ai.activity':
        this.showTyping(String(data.label ?? ''));
        break;
      case 'ai.delta': {
        if (!this.streamingBubble) {
          // The reply's own row replaces the typing dots while its words arrive.
          this.hideTyping();
          this.streamingBubble = this.messageRow('assistant', new Date()).row;
          this.streamingBubble.dataset.raw = '';
          this.log.appendChild(this.streamingBubble);
        }
        this.streamingBubble.dataset.raw = (this.streamingBubble.dataset.raw ?? '') + String(data.text ?? '');
        renderText(this.streamingBubble.querySelector<HTMLElement>('.msg')!, this.streamingBubble.dataset.raw);
        this.scroll();
        break;
      }
      case 'message': {
        const m = data.message as PublicMessage;
        if (m.role !== 'user') {
          this.streamingBubble?.remove();
          this.streamingBubble = null;
          this.hideTyping();
        }
        this.addBubble(m);
        break;
      }
      case 'ai.done':
        this.streamingBubble?.remove();
        this.streamingBubble = null;
        this.hideTyping();
        if (!data.messageId) void this.catchUp();
        break;
      case 'conversation.status':
        this.setStatus(data.status as Status);
        break;
    }
  }

  private addBubble(m: PublicMessage): HTMLElement | null {
    if (this.rendered.has(m.id)) return null;
    if (m.role === 'agent' && this.status === 'human_active' && !this.teamReplied) {
      this.teamReplied = true;
      this.renderHeader();
    }
    // A message of the visitor's from the server: they have written, so the starters are done.
    if (m.role === 'user' && !m.id.startsWith('local-')) this.removeStarters();
    // Replace the optimistic copy of our own message once the server echoes it.
    if (m.role === 'user') {
      const local = [...this.log.querySelectorAll<HTMLElement>('.msg.user[data-local]')].find((n) => n.dataset.content === m.content);
      if (local && !m.id.startsWith('local-')) {
        local.removeAttribute('data-local');
        local.dataset.id = m.id;
        this.rendered.add(m.id);
        this.track(m.id);
        return null;
      }
    }
    this.rendered.add(m.id);
    if (m.id !== 'greeting') this.track(m.id);
    const sent = new Date(m.createdAt);
    const at = Number.isNaN(sent.getTime()) ? new Date() : sent;
    this.dayLabel(at);
    const { row, col, bubble, meta } = this.messageRow(m.role, at);
    renderText(bubble, m.content);
    if (m.id.startsWith('local-')) {
      bubble.setAttribute('data-local', '');
      bubble.dataset.content = m.content;
    }
    if (m.sources.length) {
      const wrap = el('div', 'sources');
      for (const s of m.sources.slice(0, 3)) {
        const a = el('a');
        a.innerHTML = ICON_DOC;
        a.append(el('span', undefined, s.title.split(' › ').pop()));
        // Any other kind of address shows the source's name without a link.
        const href = safeLink(s.url);
        if (href) {
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
        wrap.appendChild(a);
      }
      col.insertBefore(wrap, meta);
    }
    this.log.appendChild(row);
    this.scroll();
    return row;
  }

  /**
   * A message's row: the assistant's and the team's on the left with a picture, the visitor's on the right, each with
   * its time underneath (and the assistant's name).
   */
  private messageRow(role: PublicMessage['role'], at: Date) {
    const row = el('div', `row ${role === 'user' ? 'me' : role}`);
    const col = el('div', 'col');
    const bubble = el('div', `msg ${role}`);
    const meta = el('div', 'meta');
    if (role === 'assistant') {
      row.append(this.botFace());
      meta.append(el('span', 'name', this.config ? `${this.config.assistantName} · ` : ''));
    } else if (role === 'agent') {
      const face = el('div', 'av person');
      face.setAttribute('aria-hidden', 'true');
      face.innerHTML = ICON_PERSON;
      row.append(face);
      col.append(el('div', 'label', 'Team member'));
    }
    meta.append(timeOf(at));
    col.append(bubble, meta);
    row.append(col);
    return { row, col, bubble, meta };
  }

  /** "Today" (or the date) over the first message of each day. */
  private dayLabel(at: Date) {
    const day = at.toDateString();
    if (day === this.lastDay) return;
    this.lastDay = day;
    this.log.appendChild(el('div', 'day', dayOf(at)));
  }

  /** What the chat is called: the header title the business chose, else its name, else the assistant's. */
  private displayName(): string {
    const c = this.config;
    return c ? c.theme.title || c.companyName || c.assistantName : '';
  }

  /** The assistant's picture: its logo, else the initials; filled in once the settings are in. */
  private botFace(): HTMLElement {
    const av = el('div', 'av bot');
    av.setAttribute('aria-hidden', 'true');
    this.fillFace(av);
    return av;
  }

  private fillFace(av: HTMLElement) {
    if (!this.config) return;
    const initials = initialsOf(this.displayName());
    av.textContent = initials;
    const src = this.config.theme.avatarUrl;
    if (!src) return;
    const img = el('img');
    img.alt = '';
    // A logo that won't load leaves the initials.
    img.addEventListener('error', () => {
      av.textContent = initials;
    });
    img.src = src;
    av.textContent = '';
    av.append(img);
  }

  private track(id: string) {
    if (!id.startsWith('local-')) this.lastMessageId = id;
  }

  private setStatus(status: Status) {
    if (status === this.status) return;
    const announce = announcesHandoff(this.status, status, this.ready);
    this.status = status;
    if (status !== 'human_active') this.teamReplied = false;
    if (announce) this.showHandoffNotice();
    this.renderHeader();
  }

  /** The header's second line, and the AI tag only while the assistant answers. */
  private renderHeader() {
    this.subtitle.textContent = headerLine(this.status, this.teamReplied, this.usualSubtitle);
    this.aiChip.style.display = this.status === 'human_active' ? 'none' : '';
  }

  private showHandoffNotice() {
    const notice = el('div', 'notice');
    notice.innerHTML = ICON_PERSON;
    notice.append(el('span', undefined, 'A member of our team will reply here'));
    this.log.appendChild(notice);
    this.hideTyping();
    this.scroll();
  }

  /** The assistant's picture and a bubble of dots under the chat, with what it's doing ("Checking availability…"). */
  private showTyping(label = '') {
    this.statusLine.textContent = '';
    const dots = el('span', 'dots');
    dots.append(el('i'), el('i'), el('i'));
    this.statusLine.append(this.botFace(), dots);
    if (label) this.statusLine.append(el('span', 'activity', label));
    // The chat area just got shorter: keep its latest message in view.
    this.scroll();
  }

  private hideTyping() {
    this.statusLine.textContent = '';
  }

  private error(text: string) {
    this.errorLine.textContent = text;
  }

  private scroll() {
    this.log.scrollTop = this.log.scrollHeight;
  }
}

declare global {
  interface Window {
    OmniChat?: { open(): void; close(): void; toggle(): void };
  }
}

function boot() {
  if (!KEY || !API || window.OmniChat) return;
  recordFirstTouch();
  const widget = new ChatWidget();
  window.OmniChat = { open: () => widget.toggle(true), close: () => widget.toggle(false), toggle: () => widget.toggle() };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export {};
