/**
 * Words, the way people count them: pieces of text split on any whitespace (spaces, tabs, line breaks, however many in
 * a row), keeping only pieces that have a letter or a number in them, so a lone "-" or "—" is not a word. The dashboard
 * keeps an identical copy (`apps/dashboard/src/lib/words.ts`) so the counter and the server agree; a test compares them.
 */
export function countWords(text: string): number {
  let count = 0;
  for (const piece of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(piece)) count++;
  return count;
}

/** The longest the assistant's instructions may be. */
export const MAX_INSTRUCTION_WORDS = 5000;
