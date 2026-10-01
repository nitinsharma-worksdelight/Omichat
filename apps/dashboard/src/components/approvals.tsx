import { useQuery } from '@tanstack/react-query';
import { ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { get, post } from '../lib/api';
import { formatDateTime, timeAgo } from '../lib/format';
import { useAction } from '../lib/mutations';
import { roleAtLeast } from '../lib/queries';
import { Link } from '../lib/router';
import type { Approval, ApprovalStatus } from '../lib/types';
import { Badge, Button, cx, Input, Textarea, type Tone } from './ui';

/** The assistant's requests, newest first (up to 100). Refreshed every half minute so new ones show up. */
export const useApprovals = (params: { status?: ApprovalStatus; conversationId?: string } = {}) =>
  useQuery({
    queryKey: ['approvals', params],
    queryFn: () => get<Approval[]>('/v1/approvals', { ...params, limit: 100 }),
    refetchInterval: 30_000,
  });

const STATUS_TONE: Record<ApprovalStatus, Tone> = { pending: 'amber', approved: 'green', rejected: 'red', expired: 'slate' };
const STATUS_LABEL: Record<ApprovalStatus, string> = { pending: 'Waiting', approved: 'Approved', rejected: 'Declined', expired: 'Expired' };

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/**
 * One request: what the assistant asks to do, and (for agents, while it waits) approve or decline, each with an
 * optional message to the customer. The AI keeps the conversation either way.
 */
export function ApprovalCard({ approval, showContact, className }: { approval: Approval; showContact?: boolean; className?: string }) {
  const { role } = useAuth();
  const canDecide = roleAtLeast(role, 'agent') && approval.status === 'pending';
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const refresh = [['approvals'], ['messages', approval.conversationId], ['timeline', approval.conversationId]];
  const close = () => {
    setMode(null);
    setMessage('');
    setReason('');
  };
  const approve = useAction(() => post<Approval>(`/v1/approvals/${approval.id}/approve`, message.trim() ? { message: message.trim() } : {}), {
    invalidate: refresh,
    success: 'Approved: the assistant did it',
    onSuccess: close,
  });
  const reject = useAction(
    () => post<Approval>(`/v1/approvals/${approval.id}/reject`, { ...(reason.trim() ? { reason: reason.trim() } : {}), ...(message.trim() ? { message: message.trim() } : {}) }),
    { invalidate: refresh, success: 'Declined', onSuccess: close },
  );
  const who = approval.contact.name || approval.contact.email || approval.contact.phone || 'A visitor';

  return (
    <div className={cx('rounded-xl border px-4 py-3.5', approval.status === 'pending' ? 'border-warning/35 bg-warning-soft' : 'border-border bg-surface shadow-card', className)}>
      <div className="flex items-start gap-3">
        <span
          className={cx(
            'flex size-7 shrink-0 items-center justify-center rounded-lg',
            approval.status === 'pending' ? 'bg-warning/15 text-warning' : 'bg-surface-2 text-muted',
          )}
          aria-hidden
        >
          <ShieldQuestion className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-2 pt-0.5 text-body font-semibold text-fg">
            {approval.summary}
            <ApprovalStatusBadge status={approval.status} />
            {approval.contact.isTest && <Badge tone="blue">Test</Badge>}
          </p>
          <p className="text-caption text-muted">
            {showContact && (
              <>
                <Link to={`/conversations/${approval.conversationId}`} className="font-medium text-accent-text hover:underline">
                  {who}
                </Link>
                {' · '}
              </>
            )}
            Asked {timeAgo(approval.requestedAt)}
            {approval.status === 'pending' && ` · expires ${formatDateTime(approval.expiresAt)}`}
            {approval.decidedBy && ` · ${approval.status === 'approved' ? 'approved' : 'declined'} by ${approval.decidedBy.name}`}
            {approval.reason && ` · “${approval.reason}”`}
          </p>
          {canDecide && !mode && (
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="primary" onClick={() => setMode('approve')}>
                Approve…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode('reject')}>
                Decline…
              </Button>
            </div>
          )}
          {canDecide && mode && (
            <div className="space-y-2 pt-2">
              {mode === 'reject' && (
                <Input aria-label="Reason" placeholder="Why (optional; the assistant sees it)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              )}
              <Textarea
                aria-label="Message to the customer"
                rows={2}
                placeholder="Message to the customer (optional; the AI stays on the conversation)"
                value={message}
                maxLength={4000}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div className="flex gap-2">
                {mode === 'approve' ? (
                  <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
                    Approve
                  </Button>
                ) : (
                  <Button size="sm" variant="danger" loading={reject.isPending} onClick={() => reject.mutate()}>
                    Decline
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={approve.isPending || reject.isPending} onClick={close}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
