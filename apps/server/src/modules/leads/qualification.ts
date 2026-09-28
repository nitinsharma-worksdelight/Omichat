import { and, eq } from 'drizzle-orm';
import { schema } from '../../db/client';
import type { LeadTier, QualificationAnswer, QualificationStatus } from '../../db/schema';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import { notFound } from '../../lib/errors';
import { recordEvent } from '../automation/events';
import type { QualificationConfig, QualificationQuestion, QualificationRule } from '../bots/config';
import type { ContactsService } from '../contacts/service';

export type AnswerValue = string | number | boolean | string[];

export interface ScoreResult {
  score: number;
  tier: LeadTier;
  status: QualificationStatus;
  disqualifiedBy: string[];
  matchedRules: Array<{ questionKey: string; operator: string; points: number }>;
  answeredKeys: string[];
  missingRequired: QualificationQuestion[];
}

// ---------------- pure scoring engine ----------------

/** Normalizes a raw answer to the question's type. Returns an error string the AI can act on. */
export function normalizeAnswer(q: QualificationQuestion, raw: unknown): { ok: true; value: AnswerValue } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: false, error: `No answer given for "${q.key}"` };
  switch (q.type) {
    case 'text':
      return { ok: true, value: String(raw).trim().slice(0, 1000) };
    case 'number': {
      const n = typeof raw === 'number' ? raw : parseNumberish(String(raw));
      return n === null ? { ok: false, error: `"${q.key}" needs a number` } : { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (['yes', 'y', 'true', '1', 'yeah', 'yep', 'sure'].includes(s)) return { ok: true, value: true };
      if (['no', 'n', 'false', '0', 'nope', 'not really'].includes(s)) return { ok: true, value: false };
      return { ok: false, error: `"${q.key}" needs a yes/no answer` };
    }
    case 'select': {
      const match = matchOption(q.options, String(raw));
      return match ? { ok: true, value: match } : { ok: false, error: `"${q.key}" must be one of: ${q.options.join(', ')}` };
    }
    case 'multi_select': {
      const items = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,;]/);
      const matched = items.map((i) => matchOption(q.options, i)).filter((m): m is string => Boolean(m));
      return matched.length
        ? { ok: true, value: [...new Set(matched)] }
        : { ok: false, error: `"${q.key}" must use these options: ${q.options.join(', ')}` };
    }
    case 'date': {
      const s = String(raw).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
        ? { ok: true, value: s }
        : { ok: false, error: `"${q.key}" needs a date as YYYY-MM-DD` };
    }
  }
}

/** "$50k", "50,000", "1.5m" → number. */
export function parseNumberish(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/[$€£₹,\s]/g, '');
  const m = /^(-?\d+(?:\.\d+)?)(k|m|b|lakh|lac|cr|crore)?$/.exec(s);
  if (!m) return null;
  const base = Number(m[1]);
  const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, lakh: 1e5, lac: 1e5, cr: 1e7, crore: 1e7 };
  return base * (m[2] ? mult[m[2]]! : 1);
}

function matchOption(options: string[], raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return options.find((o) => o.toLowerCase() === s) ?? options.find((o) => o.toLowerCase().startsWith(s) && s.length >= 3) ?? null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(`${v}T00:00:00Z`);
    return parseNumberish(v);
  }
  return null;
}

const eqi = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;

export function ruleMatches(rule: QualificationRule, answer: AnswerValue | undefined): boolean {
  if (rule.operator === 'answered') return answer !== undefined;
  if (answer === undefined) return false;
  const v = rule.value;
  const list = Array.isArray(v) ? v : v === null ? [] : [String(v)];
  switch (rule.operator) {
    case 'equals':
      return Array.isArray(answer) ? answer.some((a) => eqi(a, v)) : eqi(answer, typeof answer === 'number' ? asNumber(v) : v);
    case 'not_equals':
      return !(Array.isArray(answer) ? answer.some((a) => eqi(a, v)) : eqi(answer, typeof answer === 'number' ? asNumber(v) : v));
    case 'in':
      return Array.isArray(answer) ? answer.some((a) => list.some((l) => eqi(a, l))) : list.some((l) => eqi(String(answer), l));
    case 'not_in':
      return Array.isArray(answer) ? !answer.some((a) => list.some((l) => eqi(a, l))) : !list.some((l) => eqi(String(answer), l));
    case 'contains':
      return Array.isArray(answer)
        ? answer.some((a) => eqi(a, v))
        : String(answer).toLowerCase().includes(String(v ?? '').toLowerCase());
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(answer);
      const b = asNumber(v);
      if (a === null || b === null) return false;
      return rule.operator === 'gt' ? a > b : rule.operator === 'gte' ? a >= b : rule.operator === 'lt' ? a < b : a <= b;
    }
  }
}

/** Deterministic: same answers + same config → same score, tier and status. */
export function scoreLead(config: QualificationConfig, answers: Record<string, AnswerValue>): ScoreResult {
  let score = 0;
  const disqualifiedBy: string[] = [];
  const matchedRules: ScoreResult['matchedRules'] = [];
  for (const rule of config.rules) {
    if (!ruleMatches(rule, answers[rule.questionKey])) continue;
    matchedRules.push({ questionKey: rule.questionKey, operator: rule.operator, points: rule.points });
    score += rule.points;
    if (rule.disqualify) disqualifiedBy.push(rule.questionKey);
  }
  const answeredKeys = config.questions.filter((q) => answers[q.key] !== undefined).map((q) => q.key);
  const missingRequired = config.questions.filter((q) => q.required && answers[q.key] === undefined);
  const tier: LeadTier = score >= config.thresholds.hot ? 'hot' : score >= config.thresholds.warm ? 'warm' : 'cold';
  let status: QualificationStatus;
  if (disqualifiedBy.length) status = 'disqualified';
  else if (answeredKeys.length === 0) status = 'not_started';
  else if (missingRequired.length) status = 'in_progress';
  else status = score >= config.qualifyAt ? 'qualified' : 'disqualified';
  return { score, tier, status, disqualifiedBy, matchedRules, answeredKeys, missingRequired };
}

/**
 * The stored answers that still fit this bot's current questions, normalized to them. An answer to a question
 * that has since been edited (other options, another type), or that another bot asked differently, doesn't
 * count, so the bot asks again. The stored answer itself is left alone, as history.
 */
export function currentAnswers(config: QualificationConfig, stored: Record<string, QualificationAnswer>): Record<string, AnswerValue> {
  const out: Record<string, AnswerValue> = {};
  for (const q of config.questions) {
    const answer = stored[q.key];
    if (!answer) continue;
    const normalized = normalizeAnswer(q, answer.value);
    if (normalized.ok) out[q.key] = normalized.value;
  }
  return out;
}

// ---------------- service ----------------

export interface RecordAnswersResult extends ScoreResult {
  accepted: string[];
  errors: string[];
  nextQuestion: QualificationQuestion | null;
  /** True when this call moved the lead into qualified/disqualified. */
  finalized: boolean;
}

export class QualificationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly contacts: ContactsService,
  ) {}

  /**
   * Stores answers, rescores on the answers that fit the current questions, and applies the configured
   * outcome (tags, lifecycle stage, events) once per verdict: when the lead first becomes qualified or
   * disqualified, and again if a disqualified lead later qualifies. A qualified lead stays qualified.
   */
  async recordAnswers(
    scope: Scope,
    input: {
      contactId: string;
      conversationId?: string | null;
      /** The bot whose questions these are; kept on each answer and on the events. */
      botId?: string | null;
      config: QualificationConfig;
      answers: Array<{ questionKey: string; value: unknown }>;
      actor: 'ai' | 'user';
    },
  ): Promise<RecordAnswersResult> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const orgId = scope.orgId;
      const contact = await this.contacts.row(tx, orgId, input.contactId);
      const byKey = new Map(input.config.questions.map((q) => [q.key, q]));
      const stored: Record<string, QualificationAnswer> = { ...contact.qualification };
      const accepted: string[] = [];
      const errors: string[] = [];
      const mirror: Record<string, unknown> = {};
      const now = new Date().toISOString();

      for (const { questionKey, value } of input.answers) {
        const q = byKey.get(questionKey);
        if (!q) {
          errors.push(`Unknown question "${questionKey}"`);
          continue;
        }
        const normalized = normalizeAnswer(q, value);
        if (!normalized.ok) {
          errors.push(normalized.error);
          continue;
        }
        stored[q.key] = { value: normalized.value, answeredAt: now, ...(input.botId ? { botId: input.botId } : {}) };
        accepted.push(q.key);
        if (q.saveToCustomField) mirror[q.saveToCustomField] = normalized.value;
      }

      const answers = currentAnswers(input.config, stored);
      const result = scoreLead(input.config, answers);
      const before = contact.qualificationStatus;
      // Qualified is a milestone that stays (staff can reset it). A disqualified lead becomes qualified as soon
      // as their answers qualify; otherwise a verdict, once reached, stands.
      const status: QualificationStatus =
        before === 'qualified' ? 'qualified' : before === 'disqualified' ? (result.status === 'qualified' ? 'qualified' : 'disqualified') : result.status;
      const finalized = status !== before && (status === 'qualified' || status === 'disqualified');

      let customFields = contact.customFields;
      if (Object.keys(mirror).length) {
        const { defaultCountry } = await this.contacts.orgSettings(tx, orgId);
        const { values } = await this.contacts.coerceCustomFields(tx, orgId, mirror, { aiOnly: false, defaultCountry });
        customFields = { ...customFields, ...values };
      }

      const outcome = status === 'qualified' ? input.config.onQualified : status === 'disqualified' ? input.config.onDisqualified : null;
      await tx
        .update(schema.contacts)
        .set({
          qualification: stored,
          customFields,
          leadScore: result.score,
          leadTier: result.tier,
          qualificationStatus: status,
          lifecycleStage: finalized && outcome?.lifecycleStage ? outcome.lifecycleStage : contact.lifecycleStage,
          lastActivityAt: new Date(),
        })
        .where(and(eq(schema.contacts.id, contact.id), eq(schema.contacts.organizationId, orgId)));

      if (accepted.length) {
        await recordEvent(tx, {
          orgId,
          type: 'lead.qualification_updated',
          actor: input.actor,
          contactId: contact.id,
          conversationId: input.conversationId,
          payload: { answered: accepted, score: result.score, tier: result.tier, status, botId: input.botId ?? null },
        });
      }
      if (finalized && outcome) {
        if (outcome.tags.length) {
          await this.contacts.addTags({ orgId, tx }, contact.id, outcome.tags, { addedBy: 'system', allowCreate: true });
        }
        await recordEvent(tx, {
          orgId,
          type: status === 'qualified' ? 'lead.qualified' : 'lead.disqualified',
          actor: input.actor,
          contactId: contact.id,
          conversationId: input.conversationId,
          payload: {
            score: result.score,
            tier: result.tier,
            answers,
            disqualifiedBy: result.disqualifiedBy,
            notifyTeam: outcome.notifyTeam,
            botId: input.botId ?? null,
            // A re-qualification: this lead had been disqualified before.
            ...(before === 'disqualified' ? { previousStatus: before } : {}),
          },
        });
      }

      const nextQuestion =
        input.config.questions.find((q) => q.required && answers[q.key] === undefined) ??
        input.config.questions.find((q) => answers[q.key] === undefined) ??
        null;
      return { ...result, status, accepted, errors, nextQuestion, finalized };
    });
  }

  /** Current progress for the prompt: this bot's answers that still fit its questions, and what is still missing. */
  progress(config: QualificationConfig, stored: Record<string, QualificationAnswer>) {
    const answers = currentAnswers(config, stored);
    const result = scoreLead(config, answers);
    return {
      ...result,
      answers,
      nextQuestion:
        config.questions.find((q) => q.required && answers[q.key] === undefined) ??
        config.questions.find((q) => answers[q.key] === undefined) ??
        null,
    };
  }

  async reset(scope: Scope, contactId: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const result = await tx
        .update(schema.contacts)
        .set({ qualification: {}, qualificationStatus: 'not_started', leadScore: 0, leadTier: null })
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, scope.orgId)))
        .returning({ id: schema.contacts.id });
      if (!result.length) throw notFound('Contact');
    });
  }
}

