/**
 * Words, the way people count them: pieces of text split on any whitespace (spaces, tabs, line breaks, however many in
 * a row), keeping only pieces that have a letter or a number in them, so a lone "-" or "—" is not a word. Same rule as
 * the server's `countWords` (`apps/server/src/lib/words.ts`); a test compares them. No React or browser APIs here.
 */
export function countWords(text: string): number {
  let count = 0;
  for (const piece of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(piece)) count++;
  return count;
}

/** The longest the assistant's instructions may be. */
export const MAX_INSTRUCTION_WORDS = 5000;

/**
 * Whether a text box may take `next` in place of `previous`: anything within the limit, and always a change that
 * doesn't add words (deleting, or typing spaces and line breaks), so a text already over can still be cut down.
 */
export function acceptsEdit(previous: string, next: string, max = MAX_INSTRUCTION_WORDS): boolean {
  const words = countWords(next);
  return words <= max || words <= countWords(previous);
}
