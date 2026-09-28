import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import type { QualificationConfig } from '../src/modules/bots/config';
import { createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * Qualification follows the customer's current answers to the questions the bot asks now: a disqualified
 * lead can become qualified (a qualified one stays qualified), and answers that no longer fit the questions
 * are asked again instead of silently counting — while staying stored as history.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

const QUESTIONS = [
  { key: 'treatment', question: 'Which treatment?', type: 'select' as const, options: ['Invisalign', 'Cleaning'], required: true, saveToCustomField: null },
  { key: 'timeline', question: 'When would you like to start?', type: 'select' as const, options: ['ASAP', 'Later'], required: true, saveToCustomField: null },
];
const RULES = [
  { questionKey: 'treatment', operator: 'equals' as const, value: 'Invisalign', points: 40, disqualify: false },
  { questionKey: 'timeline', operator: 'equals' as const, value: 'ASAP', points: 40, disqualify: false },
];

async function clinic(questions: QualificationConfig['questions'] = QUESTIONS) {
  const org = await createOrg(t.c, 'Qualification Clinic');
  const bot = await t.c.bots.update(org.scope, org.bot.id, {
    config: {
      qualification: {
        enabled: true,
        questions,
        rules: RULES,
        thresholds: { hot: 70, warm: 40 },
        qualifyAt: 60,
        onQualified: { tags: ['qualified-lead'], lifecycleStage: 'qualified', notifyTeam: true },
        onDisqualified: { tags: ['not-now'], lifecycleStage: 'engaged', notifyTeam: false },
        qualifiedNextStep: 'offer_booking',
      },
    },
  });
  return { ...org, bot };
}
type Clinic = Awaited<ReturnType<typeof clinic>>;

const record = (org: Clinic, contactId: string, answers: Array<{ questionKey: string; value: unknown }>) =>
  t.c.qualification.recordAnswers(org.scope, { contactId, config: org.bot.config.qualification, botId: org.bot.id, answers, actor: 'ai' });

const eventsOf = (orgId: string, contactId: string, type: string) =>
  t.c.db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.organizationId, orgId), eq(schema.events.contactId, contactId), eq(schema.events.type, type)));

describe('verdicts follow the answers', () => {
  it('a disqualified lead who now qualifies becomes qualified, and the qualified outcome runs once', async () => {
    const org = await clinic();
    const lee = await t.c.contacts.create(org.scope, { firstName: 'Lee' });
    expect((await record(org, lee.id, [{ questionKey: 'treatment', value: 'Invisalign' }, { questionKey: 'timeline', value: 'Later' }])).status).toBe('disqualified');

    const r = await record(org, lee.id, [{ questionKey: 'timeline', value: 'ASAP' }]);
    expect(r).toMatchObject({ status: 'qualified', finalized: true, score: 80 });
    const contact = await t.c.contacts.get(org.scope, lee.id);
    expect(contact).toMatchObject({ qualificationStatus: 'qualified', lifecycleStage: 'qualified' });
    expect(contact.tags.map((x) => x.name)).toEqual(expect.arrayContaining(['qualified-lead', 'not-now']));
    const qualified = await eventsOf(org.orgId, lee.id, 'lead.qualified');
    expect(qualified).toHaveLength(1);
    expect(qualified[0]!.payload).toMatchObject({ previousStatus: 'disqualified', botId: org.bot.id });

    // Saying it again changes nothing.
    await record(org, lee.id, [{ questionKey: 'timeline', value: 'ASAP' }]);
    expect(await eventsOf(org.orgId, lee.id, 'lead.qualified')).toHaveLength(1);
  });

  it('a qualified lead stays qualified when a later answer would not qualify', async () => {
    const org = await clinic();
    const ann = await t.c.contacts.create(org.scope, { firstName: 'Ann' });
    await record(org, ann.id, [{ questionKey: 'treatment', value: 'Invisalign' }, { questionKey: 'timeline', value: 'ASAP' }]);
    const r = await record(org, ann.id, [{ questionKey: 'timeline', value: 'Later' }]);
    expect(r.status).toBe('qualified');
    expect((await t.c.contacts.get(org.scope, ann.id)).qualificationStatus).toBe('qualified');
    expect(await eventsOf(org.orgId, ann.id, 'lead.disqualified')).toHaveLength(0);
  });
});

describe('answers that no longer fit', () => {
  it('are asked again and not counted after the questions change, but stay stored as history', async () => {
    const budget = { key: 'budget', question: 'What budget do you have in mind?', type: 'text' as const, options: [], required: false, saveToCustomField: null };
    const org = await clinic([...QUESTIONS, budget]);
    const kim = await t.c.contacts.create(org.scope, { firstName: 'Kim' });
    await record(org, kim.id, [
      { questionKey: 'treatment', value: 'Invisalign' },
      { questionKey: 'timeline', value: 'ASAP' },
      { questionKey: 'budget', value: 'around 5k' },
    ]);
    // The business renames its timeline options and turns budget into a choice.
    const edited = await t.c.bots.update(org.scope, org.bot.id, {
      config: {
        qualification: {
          ...org.bot.config.qualification,
          questions: [
            QUESTIONS[0]!,
            { ...QUESTIONS[1]!, options: ['As soon as possible', 'Within a month', 'Just researching'] },
            { ...budget, type: 'select', options: ['Under $2,000', '$2,000–$5,000', 'Over $5,000'] },
          ],
          rules: [RULES[0]!, { ...RULES[1]!, value: 'As soon as possible' }],
        },
      },
    });
    const stored = (await t.c.contacts.get(org.scope, kim.id)).qualification;
    const progress = t.c.qualification.progress(edited.config.qualification, stored);
    expect(progress.answeredKeys).toEqual(['treatment']);
    expect(progress.answers).toEqual({ treatment: 'Invisalign' });
    expect(progress.nextQuestion?.key).toBe('timeline');
    expect(progress.score).toBe(40);
    // Kept as history.
    expect(stored.timeline?.value).toBe('ASAP');
    expect(stored.budget?.value).toBe('around 5k');
  });

  it("another bot's answer counts only if it fits this bot's question", async () => {
    const org = await clinic();
    const implants = await t.c.bots.create(org.scope, {
      name: 'Implants assistant',
      config: {
        qualification: {
          enabled: true,
          questions: [{ key: 'timeline', question: 'When?', type: 'select', options: ['This week', 'This month'], required: true, saveToCustomField: null }],
          rules: [],
          thresholds: { hot: 70, warm: 40 },
          qualifyAt: 0,
        },
      },
    });
    const mia = await t.c.contacts.create(org.scope, { firstName: 'Mia' });
    await record(org, mia.id, [{ questionKey: 'timeline', value: 'ASAP' }]);
    const stored = (await t.c.contacts.get(org.scope, mia.id)).qualification;
    expect(t.c.qualification.progress(implants.config.qualification, stored).nextQuestion?.key).toBe('timeline');
    expect(t.c.qualification.progress(org.bot.config.qualification, stored).answers).toEqual({ timeline: 'ASAP' });
  });
});

describe('in the conversation', () => {
  it("shows the model only answers that fit this bot's questions", async () => {
    const org = await clinic();
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'noah' });
    const at = '2026-09-01T00:00:00.000Z';
    await t.c.db
      .update(schema.contacts)
      .set({
        qualification: {
          treatment: { value: 'Invisalign', answeredAt: at },
          timeline: { value: 'Next year sometime', answeredAt: at },
          budget: { value: '5000', answeredAt: at },
        },
        qualificationStatus: 'in_progress',
      })
      .where(eq(schema.contacts.id, contactId));
    t.llm.setScript([text('Sure!')]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'noah', content: 'Hi again' });
    await t.c.queue.drain();
    const block = JSON.stringify(t.llm.requests[0]!.messages.at(-1)).match(/<qualification[^>]*>(.*?)<\/qualification>/)?.[1] ?? '';
    expect(block).toContain('treatment=Invisalign');
    expect(block).not.toContain('Next year sometime');
    expect(block).not.toContain('budget');
    expect(block).toContain('next question: When would you like to start?');
  });

  it('records which bot asked, and after a re-qualification the tool offers the next step', async () => {
    const org = await clinic();
    t.llm.setScript([
      tools({ name: 'record_qualification_answers', input: { answers: [{ question_key: 'treatment', value: 'Invisalign' }, { question_key: 'timeline', value: 'Later' }] } }),
      text('No problem.'),
      tools({ name: 'record_qualification_answers', input: { answers: [{ question_key: 'timeline', value: 'ASAP' }] } }),
      text('Great!'),
    ]);
    const send = async (content: string) => {
      const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'zoe', content });
      await t.c.queue.drain();
      return r;
    };
    await send('Invisalign, but later');
    const r = await send('Actually, I want to start right away');
    const result = lastToolResults(t.llm)[0]!.content as { status: string; guidance: string };
    expect(result.status).toBe('qualified');
    expect(result.guidance).toContain('Offer to book');

    const contact = await t.c.contacts.get(org.scope, r.contactId);
    expect(contact.qualification.timeline).toMatchObject({ value: 'ASAP', botId: org.bot.id });
    const updates = await eventsOf(org.orgId, r.contactId, 'lead.qualification_updated');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((e) => (e.payload as { botId?: string }).botId === org.bot.id)).toBe(true);
  });
});
