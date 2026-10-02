/**
 * What the visitor sees while their chat is with the team. No DOM access here, so the rules are tested with the rest
 * of the suite.
 */

export type Status = 'ai_active' | 'human_active' | 'closed' | null;

/**
 * Whether moving to `next` posts "A member of our team will reply here": whenever the chat passes to the team after
 * the chat has loaded (a brand-new visitor's first handoff included), never twice in a row.
 */
export function announcesHandoff(previous: Status, next: Status, ready: boolean): boolean {
  return ready && next === 'human_active' && previous !== 'human_active';
}

/** The header's second line: the usual one, or where things stand with the team. */
export function headerLine(status: Status, teamReplied: boolean, usual: string): string {
  if (status !== 'human_active') return usual;
  return teamReplied ? 'A team member is replying' : 'Waiting for a team member…';
}
