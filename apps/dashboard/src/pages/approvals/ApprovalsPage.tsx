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
export function ApprovalsPage() {
  const [status, setStatus] = useState<ApprovalStatus>('pending');
  const approvals = useApprovals({ status });
  const pending = useApprovals({ status: 'pending' });
  return (
    <div>
      <PageHeader title="Approvals" description="Actions the assistant asked your team to approve before doing them. The customer is told a team member will confirm." />
      <div className="space-y-5 px-4 sm:px-8 py-6">
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
