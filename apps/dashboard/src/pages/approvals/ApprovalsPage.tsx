import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ApprovalCard, useApprovals } from '../../components/approvals';
import { EmptyState, PageHeader, QueryState, Tabs } from '../../components/ui';
import type { ApprovalStatus } from '../../lib/types';

const TABS: Array<{ id: ApprovalStatus; label: string }> = [
  { id: 'pending', label: 'Waiting' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Declined' },
  { id: 'expired', label: 'Expired' },
];

const EMPTY: Record<ApprovalStatus, string> = {
  pending: 'Nothing is waiting for you. Actions you set to "Ask the team first" (on a bot, or on a workflow) show up here.',
  approved: 'No approved requests yet.',
  rejected: 'No declined requests yet.',
  expired: 'No expired requests. A request nobody answers expires after 7 days.',
};

/** What the assistant asked the team to approve, across conversations. */
const APPROVALS_INTRO = 'Actions the assistant asked your team to approve before doing them. The customer is told a team member will confirm.';

/** The team's approval requests. `embedded`: inside another page (Agent Logs), which has the page heading. */
export function ApprovalsPage({ embedded = false }: { embedded?: boolean }) {
  const [status, setStatus] = useState<ApprovalStatus>('pending');
  const approvals = useApprovals({ status });
  const pending = useApprovals({ status: 'pending' });
  return (
    <div>
      {embedded ? null : <PageHeader title="Approvals" description={APPROVALS_INTRO} />}
      <div className="space-y-5 px-4 sm:px-8 py-6">
        {embedded && (
          <div>
            <h2 className="text-heading font-semibold text-fg">Approvals</h2>
            <p className="mt-0.5 text-body-sm text-muted">{APPROVALS_INTRO}</p>
          </div>
        )}
        <Tabs
          ariaLabel="Requests"
          tabs={TABS.map((t) => ({ ...t, badge: t.id === 'pending' && pending.data?.length ? pending.data.length : undefined }))}
          value={status}
          onChange={setStatus}
        />
        <QueryState isLoading={approvals.isLoading} error={approvals.error} onRetry={() => void approvals.refetch()}>
          {approvals.data?.length ? (
            <div className="space-y-3">
              {approvals.data.map((a) => (
                <ApprovalCard key={a.id} approval={a} showContact />
              ))}
            </div>
          ) : (
            <EmptyState icon={<ShieldCheck className="size-5" />} title="No requests" description={EMPTY[status]} />
          )}
        </QueryState>
      </div>
    </div>
  );
}
