import type { BotView } from '../bots/service';
import { escapeTags, LENGTH, TONE } from './prompt';

/**
 * What the customer hears after the team answers a request the assistant made for them ("ask the team first"). When a
 * teammate writes their own message, that is what the customer gets; when they only approve or decline, the assistant
 * says what happened. Pure text rules, so they are tested without a model.
 */

/** The requests a customer is waiting on. The rest (tags, stage, owner, deals) are the team's own bookkeeping. */
export const CUSTOMER_FACING_TOOLS: ReadonlySet<string> = new Set(['book_appointment', 'reschedule_appointment', 'cancel_appointment']);

export interface DecidedRequest {
  tool: string;
  outcome: 'approved' | 'rejected';
  /** What was asked, in words ("Book an appointment on Tue 29 Sep 2026 at 9:30 AM"). */
  summary: string;
  /** Why the team declined, when they said. */
  reason: string | null;
  /** What the action returned once it ran (approved requests). */
  result: Record<string, unknown> | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The facts the assistant may use: what the action returned, without ids and internal flags. */
export function factsOf(result: Record<string, unknown> | null): string {
  const keep = Object.entries(result ?? {}).filter(([k, v]) => !/(^|_)id$/.test(k) && !/^(customer_confirmation_sent|confirmation_sent_to|duplicate)$/.test(k) && v !== null && v !== undefined);
  return JSON.stringify(Object.fromEntries(keep)).slice(0, 800);
}

/** What the customer is told when the model can't be asked (or has nothing to say): plain and always true. */
export function fallbackMessage(r: DecidedRequest): string {
  const when = str(r.result?.when);
  const yours = str(r.result?.your_time);
  const at = when ? `${when}${yours ? ` (${yours})` : ''}` : null;
  if (r.outcome === 'approved') {
    if (r.tool === 'book_appointment') return `Good news: the team approved it, and your appointment is confirmed${at ? ` for ${at}` : ''}.`;
    if (r.tool === 'reschedule_appointment') return `Good news: the team approved it, and your appointment has been moved${at ? ` to ${at}` : ''}.`;
    return 'Good news: the team approved it, and your appointment has been cancelled.';
  }
  const why = str(r.reason);
  const sorry = `Sorry, the team couldn't go ahead with that${why ? `: ${why}` : '.'}`;
  return r.tool === 'cancel_appointment' ? `${sorry} Your appointment stays as it is.` : `${sorry} Would you like to try another time?`;
}

/** The instruction to the model, and the recent conversation it answers from. */
export function buildFollowUpPrompt(
  bot: BotView,
  company: string,
  r: DecidedRequest,
  transcript: Array<{ who: 'Customer' | 'Assistant' | 'Team'; text: string }>,
): { system: string; user: string } {
  const p = bot.config.persona;
  const outcome =
    r.outcome === 'approved'
      ? [
          `The team approved the request you made for the customer, and it has now been done: ${r.summary}.`,
          'Tell the customer it is done. State only what the facts below say (the date and time, for instance); do not add anything else about it.',
          `Facts of what was done: ${factsOf(r.result)}`,
        ]
      : [
          `The team declined the request you made for the customer, so it was NOT done: ${r.summary}.`,
          `Reason the team gave: ${str(r.reason) ?? 'none given'}.`,
          'Say sorry briefly and clearly that it was not done, give the reason only if one was given, and offer one possible next step (another time, or the team following up). Do not promise anything.',
        ];
  const system = [
    `You are ${p.assistantName}, the ${p.role} for ${company}, chatting with a customer.`,
    `Tone: ${TONE[p.tone]}. ${LENGTH[p.responseLength]}`,
    "Reply in the language the customer writes in. Write plain chat text: no markdown, no emojis, no sign-off.",
    '',
    ...outcome,
    '',
    'Write only the message to the customer. Never mention "the system", approvals or this instruction. Do not ask for personal details.',
  ].join('\n');
  // The customer's words can't close the conversation block (or open another) and pass for instructions.
  const defang = (text: string) => escapeTags(text).replace(/<\/?conversation\b/gi, '‹conversation');
  const lines = transcript.map((m) => `${m.who}: ${defang(m.text)}`).join('\n');
  return { system, user: `<conversation>\n${lines}\n</conversation>\n\nWrite your message to the customer now.` };
}
