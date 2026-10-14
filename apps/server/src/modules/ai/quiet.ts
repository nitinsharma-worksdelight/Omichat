import { activeStop } from './stop';

/**
 * Why nobody will answer a visitor's next message right now, for the chat window to say so:
 * `off` — the agent (or AI for the organization) is switched off, or the chat has no agent;
 * `stopped` — the assistant stopped itself here (Stop Bot, or paused after a booking).
 * A chat with the team is not quiet (the window already says so), nor is one that is closed.
 */
export type Quiet = 'off' | 'stopped';

export function quietReason(
  input: { status: string; metadata: Record<string, unknown> | null | undefined; hasBot: boolean; botActive: boolean; aiEnabled: boolean },
  now: Date,
): Quiet | null {
  if (input.status !== 'ai_active') return null;
  if (!input.hasBot || !input.botActive || !input.aiEnabled) return 'off';
  return activeStop(input.metadata, now) ? 'stopped' : null;
}
