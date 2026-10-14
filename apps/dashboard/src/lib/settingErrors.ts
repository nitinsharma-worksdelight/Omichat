import { fieldLabel, type ErrorDetail } from './errors';
import type { BotConfig } from './types';

/** Checks and names for the numbers and settings an agent's save can refuse. Pure (no React or browser APIs). */

/** The limits the server enforces on the two numbers in Timing & Pacing. */
export const TIMING_LIMITS = {
  maxAiReplies: { label: 'Max AI replies per conversation', min: 1, max: 500, path: 'guardrails.maxAiRepliesPerConversation' },
  waitMinutes: { label: 'If nobody answers a handoff (minutes)', min: 0, max: 1440, path: 'handoff.waitMinutes' },
} as const;
export type TimingField = keyof typeof TIMING_LIMITS;

/** What's wrong with one of the Timing & Pacing numbers, in plain words (null when it is fine). */
export function timingFieldError(key: TimingField, value: number): string | null {
  const { min, max } = TIMING_LIMITS[key];
  if (Number.isInteger(value) && value >= min && value <= max) return null;
  return `Enter a whole number between ${min} and ${max}${key === 'waitMinutes' ? ' (0 means never)' : ''}.`;
}

/** The Timing & Pacing numbers that can't be saved, as save errors named by what the person sees. */
export function timingProblems(config: BotConfig): ErrorDetail[] {
  const values: Record<TimingField, number> = { maxAiReplies: config.guardrails.maxAiRepliesPerConversation, waitMinutes: config.handoff.waitMinutes };
  return (Object.keys(TIMING_LIMITS) as TimingField[]).flatMap((key) => {
    const message = timingFieldError(key, values[key]);
    return message ? [{ path: TIMING_LIMITS[key].path, message }] : [];
  });
}

/** Settings a save error can name, as the person sees them (anything else reads as its own words). */
const FIELD_LABELS: Record<string, string> = {
  name: 'Agent name',
  model: 'Model',
  effort: 'Reasoning effort',
  maxOutputTokens: 'Max output tokens',
  'guardrails.maxAiRepliesPerConversation': TIMING_LIMITS.maxAiReplies.label,
  'handoff.waitMinutes': TIMING_LIMITS.waitMinutes.label,
  'handoff.awayMessage': 'Away message',
  'business.website': 'Website',
  'business.email': 'Email',
  'business.phone': 'Phone',
  'business.hours': 'Opening hours',
  'business.location': 'Location',
};

/** A save error's field, in words: "Max AI replies per conversation", not `guardrails.maxAiRepliesPerConversation`. */
export function settingLabel(path: string): string {
  const key = path.startsWith('config.') ? path.slice(7) : path;
  if (!key || key === 'config') return '';
  return FIELD_LABELS[key] ?? fieldLabel(key);
}
