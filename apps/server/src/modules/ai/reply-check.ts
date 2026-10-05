/**
 * A last look at a reply before it's sent, for a bot that books: it must not say an appointment is booked when
 * nothing was booked, nor offer times the calendar didn't return. Pure text rules, no model: what it flags gets one
 * corrective round (see the orchestrator). It can't catch every wording; the server still refuses any booking the
 * calendar doesn't allow.
 */

export interface ReplyFacts {
  /** book_appointment or reschedule_appointment succeeded in this turn. */
  bookedThisTurn: boolean;
  /** The customer has upcoming appointments, which a "confirmed" may be about. */
  hasUpcoming: boolean;
  /** Slots check_availability returned this turn or recently: their start ("YYYY-MM-DDTHH:mm") and the customer's time. */
  offered: Array<{ start: string; yourTime?: string }>;
  /** Other times the reply may name: the customer's upcoming appointments ("Tue 6 Oct 2026, 3:00 PM"). */
  known: string[];
}

const CONFIRMED = /\b(booked|scheduled|confirmed|reserved)\b/i;
// A sentence about what may happen, or what didn't, isn't a claim that it happened.
const NOT_A_CLAIM = /\b(not|no|never|until|once|if|when|before|after|yet|will|would|can|could|should|to be|want|like|let me|i'll|shall)\b|n't\b/i;
const OFFER = /\b(available|availability|slots?|openings?|free|works?|would you like|how about|i can (?:do|offer)|we have|book)\b/i;
// Opening hours ("we open at 10 AM") aren't an offer of a slot, and neither is saying something isn't available.
const HOURS = /\b(open|opens|opening hours|close|closes|closed|hours)\b/i;
const NEGATIVE = /\b(no|not|none|unavailable|cannot)\b|n't\b/i;
const CLOCK_12 = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\b\.?/gi;
const CLOCK_24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?\s?m)/gi;
const WEEKDAY = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi;
const DAY_INDEX: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** The clock times in a text, as "HH:mm" (24-hour). */
export function timesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CLOCK_12)) {
    let h = Number(m[1]) % 12;
    if (m[3]!.toLowerCase() === 'p') h += 12;
    out.push(hhmm(h, Number(m[2] ?? 0)));
  }
  for (const m of text.matchAll(CLOCK_24)) out.push(hhmm(Number(m[1]), Number(m[2])));
  return out;
}

const weekdaysIn = (text: string) => [...text.matchAll(WEEKDAY)].map((m) => DAY_INDEX[m[1]!.toLowerCase()]!);
/** ISO weekday (1 = Monday) of a "YYYY-MM-DD…" date. */
const weekdayOf = (start: string) => ((new Date(`${start.slice(0, 10)}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** What's wrong with the reply, in words the model is told, or null. */
export function checkReply(text: string, facts: ReplyFacts): string | null {
  const parts = sentences(text);

  if (!facts.bookedThisTurn && !facts.hasUpcoming && parts.some((s) => CONFIRMED.test(s) && !NOT_A_CLAIM.test(s))) {
    return "Your reply says an appointment is booked, but book_appointment didn't succeed: nothing is booked.";
  }

  // A reply that offers anything: its times (a list of them may sit on lines of their own) must be ones the calendar
  // returned, or the customer's own appointments.
  if (!parts.some((s) => OFFER.test(s) && !NEGATIVE.test(s))) return null;
  const times = new Set([...facts.offered.flatMap((o) => [o.start.slice(11, 16), ...timesIn(o.yourTime ?? '')]), ...facts.known.flatMap(timesIn)]);
  const days = new Set([...facts.offered.flatMap((o) => [weekdayOf(o.start), ...weekdaysIn(o.yourTime ?? '')]), ...facts.known.flatMap(weekdaysIn)]);
  for (const s of parts) {
    if (HOURS.test(s) || NEGATIVE.test(s)) continue;
    const named = timesIn(s);
    if (named.length && !facts.offered.length && !named.every((t) => times.has(t))) {
      return `Your reply offers ${named.join(', ')}, but you haven't checked availability: call check_availability first.`;
    }
    const wrongTime = named.find((t) => !times.has(t));
    if (wrongTime) return `Your reply offers ${wrongTime}, which check_availability didn't return.`;
    if (facts.offered.length && OFFER.test(s) && weekdaysIn(s).some((d) => !days.has(d))) {
      return 'Your reply offers a day check_availability returned no slots for.';
    }
  }
  return null;
}

/** The slots in a check_availability result (its `days` or `next_available`). */
export function slotsOf(output: unknown): ReplyFacts['offered'] {
  const o = (output ?? {}) as { days?: Array<{ times?: Array<{ start?: unknown; your_time?: unknown }> }>; next_available?: Array<{ start?: unknown; your_time?: unknown }> };
  const list = [...(o.days ?? []).flatMap((d) => d.times ?? []), ...(o.next_available ?? [])];
  return list
    .filter((x): x is { start: string; your_time?: unknown } => typeof x.start === 'string')
    .map((x) => ({ start: x.start, ...(typeof x.your_time === 'string' ? { yourTime: x.your_time } : {}) }));
}
