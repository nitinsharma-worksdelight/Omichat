/**
 * Which customer messages still wait for an answer. One rule, used by the reply job, the unanswered-message sweeper
 * and the "back to the AI" path, so they never disagree.
 *
 * Rows are in conversation order (oldest first). An outbound message answers customer messages as follows:
 * - an AI reply carries `metadata.answersThrough`: the id of the latest customer message it answered. It answers that
 *   message and everything before it, but not a message that arrived while it was being written;
 * - a message tagged `metadata.notice` (the "our team hasn't replied" fallback) answers nothing;
 * - any other outbound message (staff, or older AI rows without the marker) answers everything before it.
 */
export interface MessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  metadata: Record<string, unknown>;
}

/** Metadata for an AI message that answers the customer's messages up to `triggerMessageId`. */
export const answers = (triggerMessageId: string, extra: Record<string, unknown> = {}) => ({ ...extra, answersThrough: triggerMessageId });

/** Metadata for a message to the customer that isn't an answer (it doesn't count as having replied). */
export const notice = (extra: Record<string, unknown> = {}) => ({ ...extra, notice: true });

export function pendingInbound<T extends MessageRow>(rows: T[]): T[] {
  const position = new Map(rows.map((r, i) => [r.id, i]));
  let covered = -1;
  rows.forEach((r, i) => {
    if (r.direction !== 'outbound' || r.metadata.notice === true) return;
    const through = typeof r.metadata.answersThrough === 'string' ? r.metadata.answersThrough : null;
    // A marked reply that points outside the loaded rows answers nothing here.
    const upTo = through ? (position.get(through) ?? -1) : i - 1;
    covered = Math.max(covered, upTo);
  });
  return rows.filter((r, i) => r.direction === 'inbound' && i > covered);
}
