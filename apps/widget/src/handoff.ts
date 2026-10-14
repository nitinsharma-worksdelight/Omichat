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

/**
 * Why nobody will answer the visitor's next message: the agent is switched off (`off`), or it stopped itself in this
 * chat (`stopped`: a goodbye, or paused after a booking). The window says so rather than waiting for a reply.
 */
export type Quiet = 'off' | 'stopped' | null;

/** The header's second line: the usual one, where things stand with the team, or that nobody is replying. */
export function headerLine(status: Status, teamReplied: boolean, usual: string, quiet: Quiet = null): string {
  if (status === 'human_active') return teamReplied ? 'A team member is replying' : 'Waiting for a team member…';
  if (quiet === 'off') return 'Not replying right now';
  if (quiet === 'stopped') return 'This chat has ended';
  return usual;
}

/** What the visitor is told in the chat when their message won't get a reply. */
export function quietNotice(quiet: Exclude<Quiet, null>): string {
  return quiet === 'off'
    ? "This assistant is switched off right now, so there won't be an automatic reply. Your message is saved for our team."
    : "This conversation has ended, so there won't be an automatic reply. Your messages are saved and our team can read them.";
}
