/**
 * Conversation starters: the quick options the chat offers under its greeting until the visitor writes. Pure
 * functions (no DOM), so they can be tested on their own.
 */

export interface Starter {
  id: string;
  /** The button's text. */
  label: string;
  /** Exactly what a click sends as the visitor's message. */
  message: string;
}

/** The server offers at most this many. */
const MAX_STARTERS = 10;

/**
 * The starters to offer, in the order given: none once the visitor has written in this chat. Anything malformed
 * (say, from an older or newer server) is left out rather than shown half-working.
 */
export function startersToOffer(offered: unknown, messages: ReadonlyArray<{ role: string }>): Starter[] {
  if (!Array.isArray(offered) || messages.some((m) => m.role === 'user')) return [];
  const seen = new Set<string>();
  const starters: Starter[] = [];
  for (const item of offered as unknown[]) {
    const s = item as Partial<Starter> | null;
    if (typeof s?.id !== 'string' || typeof s.label !== 'string' || typeof s.message !== 'string') continue;
    if (!s.label.trim() || !s.message.trim() || seen.has(s.id)) continue;
    seen.add(s.id);
    starters.push({ id: s.id, label: s.label, message: s.message });
  }
  return starters.slice(0, MAX_STARTERS);
}
