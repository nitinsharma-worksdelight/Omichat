/**
 * Embeddable chat widget.
 *   <script src="https://api.example.com/widget.js" data-key="pk_…" async></script>
 * Renders in a Shadow DOM (no style clashes with the host page), keeps an anonymous visitor id in
 * localStorage so the conversation survives reloads, and streams replies over SSE read with fetch().
 */

import { clamp, fromSaved, isDrag, parseSaved, placement, toSaved, type Point, type SavedPosition, type Side } from './drag';

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
}

interface PublicMessage {
  id: string;
  role: 'user' | 'assistant' | 'agent';
  content: string;
  createdAt: string;
  sources: Array<{ title: string; url: string }>;
}

type Status = 'ai_active' | 'human_active' | 'closed' | null;

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
.root { --c: #4f46e5; --bg: #ffffff; --fg: #0f172a; --muted: #64748b; --line: #e2e8f0; --bubble: #f1f5f9;
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg);
  position: fixed; bottom: 20px; z-index: 2147483000; }
.root.right { right: 20px; } .root.left { left: 20px; }
@media (prefers-color-scheme: dark) {
  .root { --bg: #0f172a; --fg: #e2e8f0; --muted: #94a3b8; --line: #1e293b; --bubble: #1e293b; }
}
.launcher { display: flex; align-items: center; gap: 8px; height: 56px; min-width: 56px; padding: 0 18px; border: 0;
  border-radius: 28px; background: var(--c); color: #fff; cursor: pointer; font: 600 15px/1 inherit;
  box-shadow: 0 8px 24px rgba(15, 23, 42, .25); transition: transform .15s; }
.launcher:hover { transform: translateY(-1px); }
.launcher svg { width: 24px; height: 24px; flex: none; }
.launcher.icon-only { padding: 0; justify-content: center; width: 56px; }
.panel { position: absolute; bottom: 72px; width: 380px; height: min(640px, calc(100vh - 110px)); display: none;
  flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(15, 23, 42, .28); }
.root.right .panel { right: 0; } .root.left .panel { left: 0; }
.root.open .panel { display: flex; }
.head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: var(--c); color: #fff; }
.head img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: rgba(255,255,255,.2); }
.head .t { font-weight: 600; font-size: 15px; } .head .s { font-size: 12px; opacity: .85; }
.head .x { margin-left: auto; background: transparent; border: 0; color: #fff; cursor: pointer; padding: 6px; border-radius: 8px; }
.head .x:hover { background: rgba(255,255,255,.15); }
.log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 85%; padding: 9px 12px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; }
.msg a { color: inherit; text-decoration: underline; }
.msg.user { align-self: flex-end; background: var(--c); color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant, .msg.agent { align-self: flex-start; background: var(--bubble); border-bottom-left-radius: 4px; }
.who { align-self: flex-start; font-size: 11px; color: var(--muted); margin: 4px 0 -4px 4px; }
.sources { align-self: flex-start; display: flex; flex-wrap: wrap; gap: 6px; margin-top: -2px; }
.sources a { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 10px; padding: 1px 8px; text-decoration: none; }
.notice { align-self: center; font-size: 12px; color: var(--muted); text-align: center; padding: 4px 8px; }
.status { min-height: 20px; padding: 0 16px 4px; font-size: 12px; color: var(--muted); }
.dots { display: inline-flex; gap: 3px; vertical-align: middle; }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: b 1.2s infinite; }
.dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
@keyframes b { 0%, 60%, 100% { opacity: .3; transform: none; } 30% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .dots i { animation: none; } .launcher { transition: none; } }
form { display: flex; gap: 8px; padding: 10px 12px 6px; border-top: 1px solid var(--line); }
.brand { padding: 0 12px 8px; font-size: 11px; line-height: 16px; color: var(--muted); }
textarea { flex: 1; resize: none; max-height: 120px; min-height: 40px; padding: 10px 12px; border: 1px solid var(--line);
  border-radius: 12px; font: inherit; color: inherit; background: transparent; outline: none; }
textarea:focus { border-color: var(--c); }
.send { flex: none; width: 40px; height: 40px; border: 0; border-radius: 12px; background: var(--c); color: #fff; cursor: pointer; }
.send:disabled { opacity: .5; cursor: default; }
.err { padding: 0 16px 6px; font-size: 12px; color: #dc2626; }
.root.moved { left: var(--x); top: var(--y); right: auto; bottom: auto; }
.root.moved .panel { left: var(--panel-x, 0px); right: auto; height: var(--panel-h, min(640px, calc(100vh - 110px))); }
.root.moved.below .panel { top: 72px; bottom: auto; }
.launcher.draggable { touch-action: none; -webkit-user-select: none; user-select: none; }
.root.dragging .launcher { cursor: grabbing; transform: none; transition: none; }
@media (max-width: 480px) {
  .root.open, .root.open.moved { inset: 0; }
  .root.open .panel, .root.open.moved .panel { position: fixed; inset: 0; width: 100%; height: 100%; border-radius: 0; bottom: 0; }
  .root.open .launcher { display: none; }
}
`;

const ICON_CHAT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_SEND =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';

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
  private readonly rendered = new Set<string>();
  private lastMessageId: string | null = null;
  private streamingBubble: HTMLDivElement | null = null;
  private streamAbort: AbortController | null = null;
  private reconnectDelay = 1000;
  private sessionPromise: Promise<void> | null = null;
  private sending = false;

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
    const avatar = el('img');
    avatar.alt = '';
    avatar.style.display = 'none';
    const titles = el('div');
    const title = el('div', 't', 'Chat with us');
    const subtitle = el('div', 's', 'We typically reply in seconds');
    titles.append(title, subtitle);
    const close = el('button', 'x');
    close.innerHTML = ICON_CLOSE;
    close.setAttribute('aria-label', 'Close chat');
    close.addEventListener('click', () => this.toggle(false));
    head.append(avatar, titles, close);

    this.log = el('div', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.statusLine = el('div', 'status');
    this.errorLine = el('div', 'err');

    const form = el('form');
    this.input = el('textarea');
    this.input.rows = 1;
    this.input.placeholder = 'Type your message…';
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

    const brand = el('div', 'brand', 'Powered by LeadsMagnet AI');
    this.panel.append(head, this.log, this.statusLine, this.errorLine, form, brand);
    this.launcher = el('button', 'launcher icon-only');
    this.launcher.innerHTML = ICON_CHAT;
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

    void this.loadConfig(title, subtitle, avatar);
    if (store('open') === '1') this.toggle(true);
  }

  private async loadConfig(title: HTMLElement, subtitle: HTMLElement, avatar: HTMLImageElement) {
    try {
      const res = await fetch(`${API}/widget/v1/config?key=${encodeURIComponent(KEY)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.config = (await res.json()) as WidgetConfig;
      const t = this.config.theme;
      if (t.primaryColor) this.root.style.setProperty('--c', t.primaryColor);
      this.side = t.position === 'left' ? 'left' : 'right';
      this.root.classList.toggle('left', this.side === 'left');
      this.root.classList.toggle('right', this.side === 'right');
      title.textContent = t.title || this.config.companyName || this.config.assistantName;
      subtitle.textContent = t.subtitle || `${this.config.assistantName} · usually replies instantly`;
      if (t.avatarUrl) {
        avatar.src = t.avatarUrl;
        avatar.style.display = '';
      }
      if (t.launcherText) {
        this.launcher.classList.remove('icon-only');
        this.launcher.innerHTML = `${ICON_CHAT}<span></span>`;
        this.launcher.querySelector('span')!.textContent = t.launcherText;
      }
      // After the launcher text: the bubble's final size decides where it may go.
      if (t.draggable) this.enableDragging();
    } catch {
      this.root.style.display = 'none'; // unknown/disabled key: stay invisible on the host page
    }
  }

  toggle(force?: boolean) {
    const open = force ?? !this.root.classList.contains('open');
    if (open) this.placePanel();
    this.root.classList.toggle('open', open);
    this.launcher.setAttribute('aria-expanded', String(open));
    store('open', open ? '1' : null);
    if (open) {
      void this.ensureSession().then(() => this.input.focus());
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
      if (!data.messages.length && this.log.childElementCount === 0 && this.config?.greeting) {
        this.addBubble({ id: 'greeting', role: 'assistant', content: this.config.greeting, createdAt: '', sources: [] });
      }
      data.messages.forEach((m) => this.addBubble(m));
      this.error('');
      if (this.conversationId) this.openStream();
    } catch (err) {
      this.error((err as Error).message);
      throw err;
    }
  }

  private async send() {
    const content = this.input.value.trim();
    if (!content || this.sending) return;
    this.sending = true;
    this.sendBtn.disabled = true;
    const clientMessageId = uid();
    const optimistic: PublicMessage = { id: `local-${clientMessageId}`, role: 'user', content, createdAt: new Date().toISOString(), sources: [] };
    this.addBubble(optimistic);
    this.input.value = '';
    this.input.style.height = '';
    try {
      await this.ensureSession();
      const post = () =>
        fetch(`${API}/widget/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ content, clientMessageId, pageUrl: pageUrl(), firstTouch: firstTouch(), timezone: timezone() }),
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
    } catch (err) {
      this.error((err as Error).message);
    } finally {
      this.sending = false;
      this.sendBtn.disabled = false;
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
          this.streamingBubble = el('div', 'msg assistant');
          this.streamingBubble.dataset.raw = '';
          this.log.appendChild(this.streamingBubble);
        }
        this.streamingBubble.dataset.raw = (this.streamingBubble.dataset.raw ?? '') + String(data.text ?? '');
        renderText(this.streamingBubble, this.streamingBubble.dataset.raw);
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

  private addBubble(m: PublicMessage) {
    if (this.rendered.has(m.id)) return;
    // Replace the optimistic copy of our own message once the server echoes it.
    if (m.role === 'user') {
      const local = [...this.log.querySelectorAll<HTMLElement>('.msg.user[data-local]')].find((n) => n.dataset.content === m.content);
      if (local && !m.id.startsWith('local-')) {
        local.removeAttribute('data-local');
        local.dataset.id = m.id;
        this.rendered.add(m.id);
        this.track(m.id);
        return;
      }
    }
    this.rendered.add(m.id);
    if (m.id !== 'greeting') this.track(m.id);
    if (m.role === 'agent') this.log.appendChild(el('div', 'who', 'Team member'));
    const bubble = el('div', `msg ${m.role}`);
    renderText(bubble, m.content);
    if (m.id.startsWith('local-')) {
      bubble.setAttribute('data-local', '');
      bubble.dataset.content = m.content;
    }
    this.log.appendChild(bubble);
    if (m.sources.length) {
      const wrap = el('div', 'sources');
      for (const s of m.sources.slice(0, 3)) {
        const a = el('a', undefined, s.title.split(' › ').pop());
        a.href = s.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        wrap.appendChild(a);
      }
      this.log.appendChild(wrap);
    }
    this.scroll();
  }

  private track(id: string) {
    if (!id.startsWith('local-')) this.lastMessageId = id;
  }

  private setStatus(status: Status) {
    if (status === this.status) return;
    const previous = this.status;
    this.status = status;
    if (status === 'human_active' && previous) {
      this.log.appendChild(el('div', 'notice', 'A member of our team will reply here.'));
      this.hideTyping();
      this.scroll();
    }
  }

  private showTyping(label = '') {
    this.statusLine.textContent = '';
    const dots = el('span', 'dots');
    dots.append(el('i'), el('i'), el('i'));
    this.statusLine.append(dots);
    if (label) this.statusLine.append(document.createTextNode(`  ${label}`));
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
