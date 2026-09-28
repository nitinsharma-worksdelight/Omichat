import { describe, expect, it } from 'vitest';
import { chunkFaq, chunkSections, estimateTokens } from '../src/modules/knowledge/chunker';
import { normalizeEmail, normalizePhone, splitName } from '../src/modules/leads/capture';

describe('chunker', () => {
  it('keeps headings as context and never mixes sections', () => {
    const text = ['# Pricing', '## Basic', 'Basic plan is $10 per month.', '## Pro', 'Pro plan is $49 per month.'].join('\n\n');
    const chunks = chunkSections('Plans', [{ text }]);
    expect(chunks.map((c) => c.title)).toEqual(['Plans › Pricing › Basic', 'Plans › Pricing › Pro']);
    expect(chunks[1]!.content).toContain('$49');
    expect(chunks[1]!.content).not.toContain('$10');
  });

  it('splits long sections to the target size with overlap', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog near the river bank. ';
    const chunks = chunkSections('Doc', [{ text: sentence.repeat(200) }], { targetTokens: 200, maxTokens: 300, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(estimateTokens(c.content)).toBeLessThanOrEqual(330);
    // consecutive chunks share some text (overlap)
    expect(chunks[1]!.content.slice(0, 40)).toContain('fox');
  });

  it('turns FAQ pairs into one chunk each', () => {
    const chunks = chunkFaq('FAQ', [
      { question: 'Do you ship to Canada?', answer: 'Yes, in 3–5 business days.' },
      { question: ' ', answer: 'ignored' },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe('Q: Do you ship to Canada?\nA: Yes, in 3–5 business days.');
  });
});

describe('lead capture normalization', () => {
  it('normalizes phone numbers to E.164 using the org default country', () => {
    expect(normalizePhone('(416) 555-0123', 'CA')).toBe('+14165550123');
    expect(normalizePhone('+91 98765 43210', 'CA')).toBe('+919876543210');
    expect(normalizePhone('98765 43210', 'IN')).toBe('+919876543210');
    expect(normalizePhone('12345', 'US')).toBeNull();
  });

  it('validates emails and splits names', () => {
    expect(normalizeEmail(' Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
    expect(normalizeEmail('jane@')).toBeNull();
    expect(splitName('  Mary   Ann  Smith ')).toEqual({ firstName: 'Mary', lastName: 'Ann Smith' });
  });
});
