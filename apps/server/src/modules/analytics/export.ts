import type { Container } from '../../container';
import type { AnalyticsQuery } from './service';

/** The reports that can be downloaded as CSV. */
export const EXPORTS = ['daily', 'handoffs', 'team', 'sources', 'actions'] as const;
export type ExportKind = (typeof EXPORTS)[number];

/** One CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export async function exportCsv(c: Container, orgId: string, timezone: string, q: AnalyticsQuery & { report: ExportKind }) {
  if (q.report === 'daily') {
    const r = await c.analytics.report(orgId, timezone, q, { includeCost: true });
    const header = ['date', 'conversations', 'leads', 'qualified', 'bookings', 'handoffs', 'deals_won', 'ai_replies'];
    const rows = r.series.map((d) => [d.date, d.conversations, d.leads, d.qualified, d.bookings, d.handoffs, d.dealsWon, d.aiReplies]);
    return { from: r.from, to: r.to, body: toCsv(header, rows) };
  }
  const p = await c.analytics.performance(orgId, timezone, q, { includeCost: true });
  switch (q.report) {
    case 'handoffs':
      return {
        from: p.from,
        to: p.to,
        body: toCsv(['reason', 'handoffs'], p.handoffs.reasons.map((r) => [r.reason, r.count])),
      };
    case 'team':
      return {
        from: p.from,
        to: p.to,
        body: toCsv(
          ['member', 'assigned', 'replies', 'conversations_answered', 'median_first_reply_seconds'],
          p.team.map((m) => [m.name, m.assigned, m.replies, m.conversations, m.firstReplyMedianSeconds]),
        ),
      };
    case 'sources':
      return {
        from: p.from,
        to: p.to,
        body: toCsv(['source', 'campaign', 'channel', 'leads'], p.sources.map((s) => [s.source, s.campaign, s.channel, s.count])),
      };
    case 'actions':
      return {
        from: p.from,
        to: p.to,
        body: toCsv(['action', 'calls', 'failed', 'asked_team'], p.actions.map((a) => [a.tool, a.calls, a.failed, a.askedTeam])),
      };
  }
}
