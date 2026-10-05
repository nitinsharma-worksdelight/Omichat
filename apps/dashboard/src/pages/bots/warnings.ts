import { WEEKDAYS, type BotConfig, type BotConfigSection, type Calendar, type ConversationStarter, type KbDocument, type LeadCapture, type Weekday, type WeeklyHours } from '../../lib/types';

/**
 * Things worth checking in a bot's settings: they don't stop a save, but the assistant would tell visitors something
 * the rest of the setup can't back up (booking that is off, hours the calendar doesn't have, a detail that holds up
 * bookings, no privacy notice). Pure functions of the settings, no UI: the server's test suite tests them directly.
 */

export interface BotWarning {
  id: string;
  /** The section it's about, where the editor shows it. */
  section: BotConfigSection;
  /** A second section it's shown in. */
  also?: BotConfigSection;
  message: string;
  /** Shown next to its field in the section (not in the section's list at the top). */
  inline?: boolean;
}

/** What the assistant can do with appointments, given its settings (the same rules the server uses for its tools). */
export interface BookingAbilities {
  book: boolean;
  move: boolean;
  cancel: boolean;
}

export function bookingAbilities(config: BotConfig): BookingAbilities {
  const off = new Set<string>(config.actions.disabledTools);
  const book = config.booking.enabled && Boolean(config.booking.calendarId) && !off.has('book_appointment');
  return {
    book,
    move: book && config.booking.allowReschedule && !off.has('reschedule_appointment'),
    cancel: book && config.booking.allowCancel && !off.has('cancel_appointment'),
  };
}

const CANCEL = /\bcancel/i;
const RESCHEDULE = /\breschedul|\b(?:move|change)\b.*\b(?:appointment|booking|visit)/i;
const BOOK = /\bbook|\bappointment|\bschedul/i;

/** Why a starter promises something the assistant can't do, or null. */
export function starterProblem(starter: Pick<ConversationStarter, 'label' | 'message'>, can: BookingAbilities): string | null {
  const text = `${starter.label} ${starter.message}`;
  if (CANCEL.test(text)) {
    return can.cancel ? null : can.book ? "Cancelling is off (Booking tab), so the assistant passes this to your team instead. Turn it on or hide this starter." : OFF;
  }
  if (RESCHEDULE.test(text)) {
    return can.move ? null : can.book ? "Rescheduling is off (Booking tab), so the assistant passes this to your team instead. Turn it on or hide this starter." : OFF;
  }
  return BOOK.test(text) && !can.book ? OFF : null;
}
const OFF = 'Booking is off, so the assistant passes this to your team instead. Turn booking on or hide this starter.';

// ---------- Opening hours ----------

const DAY_NAMES: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const SHORT: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DAY = String.raw`(mon(?:days?)?|tue(?:s(?:days?)?)?|wed(?:nesdays?)?|thu(?:r(?:s(?:days?)?)?)?|fri(?:days?)?|sat(?:urdays?)?|sun(?:days?)?)`;
const DAY_RE = new RegExp(String.raw`\b${DAY}\b`, 'gi');
const RANGE_RE = new RegExp(String.raw`\b${DAY}\b\.?\s*(?:-|–|—|to|through|thru|until|till)\s*\b${DAY}\b`, 'gi');

const dayOf = (token: string) => WEEKDAYS.find((d) => token.toLowerCase().startsWith(d)) ?? null;
function between(from: Weekday, to: Weekday): Weekday[] {
  const out: Weekday[] = [];
  for (let i = WEEKDAYS.indexOf(from); ; i = (i + 1) % 7) {
    out.push(WEEKDAYS[i]!);
    if (WEEKDAYS[i] === to || out.length === 7) return out;
  }
}

/**
 * The days an "Opening hours" text says the business is open, e.g. "Mon–Fri 9–6, Sat 10–2, closed Sun" → Mon–Sat.
 * Parts that say closed are skipped. Text it can't read gives no days, so it never raises a false alarm.
 */
export function openDaysIn(text: string): Set<Weekday> {
  const days = new Set<Weekday>();
  for (const part of text.split(/[,;\n|]+/)) {
    if (/\b(closed|shut|off)\b/i.test(part)) continue;
    let rest = part;
    for (const m of part.matchAll(RANGE_RE)) {
      const [from, to] = [dayOf(m[1]!), dayOf(m[2]!)];
      if (from && to) between(from, to).forEach((d) => days.add(d));
      rest = rest.replace(m[0], ' ');
    }
    for (const m of rest.matchAll(DAY_RE)) {
      const d = dayOf(m[1]!);
      if (d) days.add(d);
    }
    if (/\bweekends?\b/i.test(part)) ['sat', 'sun'].forEach((d) => days.add(d as Weekday));
    if (/\bweekdays?\b/i.test(part)) between('mon', 'fri').forEach((d) => days.add(d));
    if (/\b(daily|every\s*day|7\s*days|seven\s*days)\b/i.test(part)) WEEKDAYS.forEach((d) => days.add(d));
  }
  return days;
}

const time = (t: string) => t.replace(/^0(\d)/, '$1');

/** A calendar's weekly hours in a line: "Mon–Fri 9:00–17:00, Sat 10:00–14:00". */
export function hoursSummary(hours: WeeklyHours): string {
  const label = (d: Weekday) => (hours[d] ?? []).map((r) => `${time(r.start)}–${time(r.end)}`).join(', ');
  const groups: Array<{ from: Weekday; to: Weekday; label: string }> = [];
  for (const d of WEEKDAYS) {
    const l = label(d);
    if (!l) continue;
    const last = groups.at(-1);
    if (last && last.label === l && WEEKDAYS.indexOf(last.to) === WEEKDAYS.indexOf(d) - 1) last.to = d;
    else groups.push({ from: d, to: d, label: l });
  }
  if (!groups.length) return 'no open hours';
  return groups.map((g) => `${g.from === g.to ? SHORT[g.from] : `${SHORT[g.from]}–${SHORT[g.to]}`} ${g.label}`).join(', ');
}

/** The calendar the bot books on, when it can book. */
export function bookingCalendar(config: BotConfig, calendars: Calendar[]): Calendar | null {
  return bookingAbilities(config).book ? (calendars.find((c) => c.id === config.booking.calendarId) ?? null) : null;
}

/** Days the opening hours say are open but the booking calendar has no hours for. */
export function hoursMismatch(config: BotConfig, calendars: Calendar[]): { calendar: Calendar; days: Weekday[] } | null {
  const calendar = bookingCalendar(config, calendars);
  if (!calendar) return null;
  const days = [...openDaysIn(config.business.hours)].filter((d) => !(calendar.weeklyHours[d] ?? []).length);
  return days.length ? { calendar, days: WEEKDAYS.filter((d) => days.includes(d)) } : null;
}

// ---------- Opening hours in the bot's documents ----------

/** A sentence about when the business is open: an hours word or a time range. */
const HOURS_TALK = /\b(open|opens|opening|hours)\b|\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*(?:-|–|—|to|until|till)\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\b|\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\b/i;
const NOT_OPEN = /\b(closed|shut|not open|no appointments)\b/i;
const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+|\n+/);

/** The days a document says the business is open: FAQ answers (with their question, which often names the day) and plain-text documents. */
function openDaysInDocument(doc: Pick<KbDocument, 'sourceType' | 'content' | 'faq'>): Set<Weekday> {
  const days = new Set<Weekday>();
  const add = (text: string) => openDaysIn(text).forEach((d) => days.add(d));
  if (doc.sourceType === 'faq') {
    for (const item of doc.faq ?? []) {
      if (!HOURS_TALK.test(item.answer) || NOT_OPEN.test(item.answer)) continue;
      add(openDaysIn(item.answer).size ? item.answer : `${item.question} ${item.answer}`);
    }
  } else if (doc.sourceType === 'text') {
    for (const sentence of sentencesOf(doc.content ?? '')) if (HOURS_TALK.test(sentence)) add(sentence);
  }
  return days;
}

/** FAQ and plain-text documents that say the business is open on a day the booking calendar has no hours for. */
export function documentHoursMismatch(
  config: BotConfig,
  calendars: Calendar[],
  documents: Array<Pick<KbDocument, 'id' | 'title' | 'sourceType' | 'content' | 'faq'>>,
): BotWarning[] {
  const calendar = bookingCalendar(config, calendars);
  if (!calendar) return [];
  return documents.flatMap((doc) => {
    const open = openDaysInDocument(doc);
    const days = WEEKDAYS.filter((d) => open.has(d) && !(calendar.weeklyHours[d] ?? []).length);
    if (!days.length) return [];
    const names = listOf(days.map((d) => DAY_NAMES[d]));
    return [
      {
        id: `hours-document-${doc.id}`,
        section: 'business' as const,
        message: `Your ${doc.sourceType === 'faq' ? 'FAQ' : 'document'} “${doc.title}” says you're open ${names}, but ${calendar.name} has no ${names} hours: visitors may hear you're open but can't book then.`,
      },
    ];
  });
}

const listOf = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? ''));

// ---------- Privacy ----------

export function privacyNoticeMissing(lc: LeadCapture): boolean {
  return lc.enabled && lc.fields.length > 0 && !lc.consentNotice.trim();
}

// ---------- All of them ----------

const DETAIL: Record<string, string> = { name: 'name', email: 'email address', phone: 'phone number' };

/** `documents`: the bot's knowledge documents, when loaded (the editor); without them their hours aren't checked. */
export function botWarnings(config: BotConfig, calendars: Calendar[], documents: Array<Pick<KbDocument, 'id' | 'title' | 'sourceType' | 'content' | 'faq'>> = []): BotWarning[] {
  const can = bookingAbilities(config);
  const out: BotWarning[] = [];

  const starters = config.conversationStarters.filter((s) => s.enabled && starterProblem(s, can));
  if (starters.length) {
    out.push({
      id: 'starters-booking',
      section: 'conversationStarters',
      inline: true,
      message: `${starters.length === 1 ? `The “${starters[0]!.label}” starter offers` : `${starters.length} starters offer`} something the assistant can't do with your booking settings: it passes these to your team instead.`,
    });
  }

  const goals = [config.goals.primary, ...config.goals.secondary].join(' ');
  if (!can.book && BOOK.test(goals)) {
    out.push({
      id: 'goals-booking',
      section: 'goals',
      message: "Your goals mention booking, but booking is off: the assistant can't book and passes requests to your team. Turn booking on, or reword the goal.",
    });
  }

  const mismatch = hoursMismatch(config, calendars);
  if (mismatch) {
    const names = mismatch.days.map((d) => DAY_NAMES[d]);
    out.push({
      id: 'hours-calendar',
      section: 'business',
      inline: true,
      message: `Opening hours mention ${listOf(names)}, but ${mismatch.calendar.name} has no ${listOf(names)} hours: visitors may hear you're open but can't book. Check your FAQ too.`,
    });
  }

  if (can.book) {
    const lc = config.leadCapture;
    for (const field of config.booking.requiredFields) {
      if (!lc.enabled || !lc.fields.some((f) => f.field === field)) {
        out.push({
          id: `booking-needs-${field}`,
          section: 'leadCapture',
          also: 'booking',
          message: `Booking needs their ${DETAIL[field]}, but lead capture doesn't ask for it: the assistant only asks right before booking.`,
        });
      }
    }
    if (lc.enabled) {
      for (const f of lc.fields) {
        if (f.required && f.timing === 'before_booking' && f.field in DETAIL && !config.booking.requiredFields.includes(f.field as never)) {
          out.push({
            id: `holds-up-${f.field}`,
            section: 'booking',
            also: 'leadCapture',
            message: `Lead capture requires their ${DETAIL[f.field]} before booking, but booking doesn't need it: the assistant will hold up bookings for it. Make it optional, or add it to the details booking needs.`,
          });
        }
      }
    }
  }

  out.push(...documentHoursMismatch(config, calendars, documents));

  if (privacyNoticeMissing(config.leadCapture)) {
    out.push({
      id: 'privacy-notice',
      section: 'leadCapture',
      inline: true,
      message: "Add a privacy notice: the assistant collects contact details, and rules such as GDPR expect people to be told how they're used.",
    });
  }
  return out;
}
