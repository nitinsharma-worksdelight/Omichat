import { describe, expect, it } from 'vitest';
import { QualificationSchema } from '../src/modules/bots/config';
import { normalizeAnswer, parseNumberish, ruleMatches, scoreLead } from '../src/modules/leads/qualification';

const config = QualificationSchema.parse({
  enabled: true,
  questions: [
    { key: 'budget', question: 'Budget?', type: 'number' },
    { key: 'timeline', question: 'When?', type: 'select', options: ['ASAP', 'This quarter', 'Later'] },
    { key: 'role', question: 'Your role?', type: 'text', required: false },
    { key: 'student', question: 'Are you a student?', type: 'boolean', required: false },
  ],
  rules: [
    { questionKey: 'budget', operator: 'gte', value: 10000, points: 50 },
    { questionKey: 'budget', operator: 'lt', value: 1000, points: -30 },
    { questionKey: 'timeline', operator: 'in', value: ['ASAP', 'This quarter'], points: 30 },
    { questionKey: 'role', operator: 'contains', value: 'founder', points: 10 },
    { questionKey: 'student', operator: 'equals', value: true, disqualify: true },
  ],
  thresholds: { hot: 70, warm: 40 },
  qualifyAt: 50,
});

describe('qualification scoring', () => {
  it('parses human numbers', () => {
    expect(parseNumberish('$15k')).toBe(15000);
    expect(parseNumberish('1.5m')).toBe(1_500_000);
    expect(parseNumberish('2 lakh')).toBe(200000);
    expect(parseNumberish('about ten')).toBeNull();
  });

  it('normalizes answers to the question type', () => {
    const [budget, timeline, , student] = config.questions;
    expect(normalizeAnswer(budget!, '20,000')).toEqual({ ok: true, value: 20000 });
    expect(normalizeAnswer(timeline!, 'asap')).toEqual({ ok: true, value: 'ASAP' });
    expect(normalizeAnswer(timeline!, 'next year')).toMatchObject({ ok: false });
    expect(normalizeAnswer(student!, 'nope')).toEqual({ ok: true, value: false });
  });

  it('is in progress until required questions are answered', () => {
    expect(scoreLead(config, {}).status).toBe('not_started');
    const partial = scoreLead(config, { budget: 20000 });
    expect(partial).toMatchObject({ status: 'in_progress', score: 50, tier: 'warm' });
    expect(partial.missingRequired.map((q) => q.key)).toEqual(['timeline']);
  });

  it('qualifies high scores and tiers them', () => {
    const r = scoreLead(config, { budget: 20000, timeline: 'ASAP', role: 'Co-founder & CEO' });
    expect(r).toMatchObject({ status: 'qualified', score: 90, tier: 'hot' });
  });

  it('disqualifies below the bar and on disqualifier rules', () => {
    expect(scoreLead(config, { budget: 500, timeline: 'Later' })).toMatchObject({ status: 'disqualified', score: -30, tier: 'cold' });
    expect(scoreLead(config, { budget: 50000, timeline: 'ASAP', student: true })).toMatchObject({ status: 'disqualified', disqualifiedBy: ['student'] });
  });

  it('evaluates operators against multi-select answers', () => {
    expect(ruleMatches({ questionKey: 'x', operator: 'in', value: ['a', 'b'], points: 1, disqualify: false }, ['c', 'B'])).toBe(true);
    expect(ruleMatches({ questionKey: 'x', operator: 'not_in', value: ['a'], points: 1, disqualify: false }, ['c'])).toBe(true);
    expect(ruleMatches({ questionKey: 'x', operator: 'answered', value: null, points: 1, disqualify: false }, undefined)).toBe(false);
  });
});
