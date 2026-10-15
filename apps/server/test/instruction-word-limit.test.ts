import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptsEdit, countWords as dashboardCountWords, MAX_INSTRUCTION_WORDS as DASHBOARD_MAX } from '../../dashboard/src/lib/words';
import { countWords, MAX_INSTRUCTION_WORDS } from '../src/lib/words';
import { authHeaders, createOrg, createTestEnv, type TestEnv } from './helpers';

/**
 * The assistant's instructions are limited by words (5,000), not characters. Spaces, tabs and line breaks, however
 * many, are not words. The dashboard's counter and the server's check use the same rule.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;
const patchInstructions = (org: Org, instructions: string) =>
  t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { instructions } } });
const words = (n: number, word = 'word') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

describe('counting words', () => {
  it('counts words, not characters', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('hello')).toBe(1);
    expect(countWords('hello world')).toBe(2);
    expect(countWords('a b c d e')).toBe(5);
    expect(countWords("don't over-think it, 2 times")).toBe(5);
  });

  it('ignores spaces, tabs and line breaks, however many in a row', () => {
    expect(countWords('   ')).toBe(0);
    expect(countWords('\n\n\t \r\n')).toBe(0);
    expect(countWords('one    two')).toBe(2);
    expect(countWords('one\n\n\n\ntwo\t\t\tthree')).toBe(3);
    expect(countWords('  leading and trailing   ')).toBe(3);
    // The same words with more white space between them give the same count.
    expect(countWords('a b c')).toBe(countWords('a \n\n b \t\t  c   \n'));
    // A non-breaking space is white space too.
    expect(countWords('one two')).toBe(2);
  });

  it('does not count punctuation on its own, and keeps other scripts', () => {
    expect(countWords('hello - world — yes')).toBe(3);
    expect(countWords('... !!! ???')).toBe(0);
    expect(countWords('- item one\n- item two')).toBe(4);
    expect(countWords('नमस्ते दुनिया')).toBe(2);
    expect(countWords('Hola, ¿cómo estás?')).toBe(3);
    expect(countWords('{business_name} opens at 9')).toBe(4);
  });

  it("the dashboard's counter gives the same answer as the server's, on every kind of text", () => {
    expect(DASHBOARD_MAX).toBe(MAX_INSTRUCTION_WORDS);
    expect(MAX_INSTRUCTION_WORDS).toBe(5000);
    const samples = ['', ' ', 'a', 'a b', 'a  b\n\nc\t\td', '- — …', 'नमस्ते दुनिया', "it's 9-5, ok?", words(50), '  \n word \n  ', 'x'.repeat(5000), 'ab cd ef'];
    for (const s of samples) expect(dashboardCountWords(s), JSON.stringify(s)).toBe(countWords(s));
  });
});

describe('the text box', () => {
  const full = words(MAX_INSTRUCTION_WORDS);

  it('takes anything within the limit', () => {
    expect(acceptsEdit('', 'hello')).toBe(true);
    expect(acceptsEdit(words(10), words(11))).toBe(true);
    expect(acceptsEdit(words(MAX_INSTRUCTION_WORDS - 1), full)).toBe(true);
  });

  it('refuses a word past the limit, and a paste that would go past it', () => {
    expect(acceptsEdit(full, `${full} one more`)).toBe(false);
    expect(acceptsEdit('', words(MAX_INSTRUCTION_WORDS + 1))).toBe(false);
    expect(acceptsEdit('short', words(6000))).toBe(false);
  });

  it('always takes deleting and white space, even at the limit', () => {
    expect(acceptsEdit(full, `${full} `)).toBe(true);
    expect(acceptsEdit(full, `${full}\n\n\n`)).toBe(true);
    expect(acceptsEdit(full, `${full}      \t`)).toBe(true);
    expect(acceptsEdit(full, words(MAX_INSTRUCTION_WORDS - 1))).toBe(true);
    expect(acceptsEdit(full, '')).toBe(true);
  });

  it('lets text that is already over the limit be cut down, but not grow', () => {
    const over = words(MAX_INSTRUCTION_WORDS + 40);
    expect(acceptsEdit(over, words(MAX_INSTRUCTION_WORDS + 10))).toBe(true);
    expect(acceptsEdit(over, `${over} extra`)).toBe(false);
  });
});

describe('the server', () => {
  it('saves exactly 5,000 words, however much white space is between them', async () => {
    const org = await createOrg(t.c, 'Word Limit Exact Co');
    const spread = words(MAX_INSTRUCTION_WORDS).split(' ').join('   \n\n\t ');
    expect(spread.length).toBeGreaterThan(12_000);
    const res = await patchInstructions(org, spread);
    expect(res.statusCode, res.body).toBe(200);
    expect(countWords(res.json().config.instructions)).toBe(MAX_INSTRUCTION_WORDS);
  });

  it('refuses 5,001 words with a clear message that names the field', async () => {
    const org = await createOrg(t.c, 'Word Limit Over Co');
    const res = await patchInstructions(org, words(MAX_INSTRUCTION_WORDS + 1));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0]).toMatchObject({ path: expect.stringContaining('instructions'), message: expect.stringContaining('at most 5,000 words') });
    // Nothing was saved.
    expect((await t.c.bots.get(org.scope, org.bot.id)).config.instructions).toBe('');
  });

  it('refuses it on create too', async () => {
    const org = await createOrg(t.c, 'Word Limit Create Co');
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/bots',
      headers: authHeaders(org.token),
      payload: { name: 'Too Wordy', config: { instructions: words(MAX_INSTRUCTION_WORDS + 1) } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not count white space: a huge run of spaces and line breaks is zero words', async () => {
    const org = await createOrg(t.c, 'Word Limit Space Co');
    const res = await patchInstructions(org, `${' '.repeat(30_000)}${'\n'.repeat(30_000)}${'\t'.repeat(30_000)}`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('accepts what the old 12,000-character limit refused, while it is within 5,000 words', async () => {
    const org = await createOrg(t.c, 'Word Limit Long Co');
    const text = words(3000, 'description-of-the-service-');
    expect(text.length).toBeGreaterThan(12_000);
    const res = await patchInstructions(org, text);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the saved instructions reach the assistant whole', async () => {
    const org = await createOrg(t.c, 'Word Limit Prompt Co');
    const text = `${words(MAX_INSTRUCTION_WORDS - 1)} finalword`;
    expect((await patchInstructions(org, text)).statusCode).toBe(200);
    const preview = (await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: authHeaders(org.token) })).json() as { system: string };
    expect(preview.system).toContain('finalword');
  });
});
