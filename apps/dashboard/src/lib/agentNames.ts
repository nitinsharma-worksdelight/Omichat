/** The name a new agent gets until the person renames it (pure: no React or browser APIs). */
export const DEFAULT_AGENT_NAME = 'Untitled';

/**
 * "Untitled 1", then "Untitled 2", and so on: one more than the highest number any agent already has, so a
 * deleted agent's number is not handed out again and other names (including "Untitled" with no number) are left alone.
 */
export function nextAgentName(existing: readonly string[]): string {
  const taken = new RegExp(`^${DEFAULT_AGENT_NAME} (\\d+)$`, 'i');
  let highest = 0;
  for (const name of existing) {
    const match = taken.exec(name.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${DEFAULT_AGENT_NAME} ${highest + 1}`;
}
