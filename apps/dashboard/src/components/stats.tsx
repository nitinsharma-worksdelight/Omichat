import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx, Skeleton } from './ui';

export type StatTone = 'neutral' | 'brand' | 'success' | 'ai' | 'human';

const tileTones: Record<StatTone, string> = {
  neutral: 'bg-surface-2 text-fg-2',
  brand: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  ai: 'bg-ai-soft text-ai',
  human: 'bg-human-soft text-human',
};

/** A small rounded-square icon chip; its tone says what the number is about (ai and human mark who acted). */
export function IconTile({ tone = 'neutral', children, className }: { tone?: StatTone; children: ReactNode; className?: string }) {
  return <span className={cx('flex size-6.5 shrink-0 items-center justify-center rounded-lg [&_svg]:size-3.5', tileTones[tone], className)}>{children}</span>;
}

/** Label row, the figure in the display face, and an optional footer (a hint, a meter, a change pill). */
export function StatValue({
  icon,
  tone,
  label,
  value,
  loading,
  footer,
}: {
  icon: ReactNode;
  tone?: StatTone;
  label: string;
  value: ReactNode;
  loading?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <IconTile tone={tone}>{icon}</IconTile>
        <span className="truncate text-caption font-medium text-muted">{label}</span>
      </div>
      {loading ? (
        <Skeleton className="h-8.5 w-20" />
      ) : (
        <p className="font-display text-display font-semibold tracking-[-0.02em] text-fg tabular-nums">{value}</p>
      )}
      {footer !== undefined && footer !== null && <div className="text-caption text-muted">{footer}</div>}
    </div>
  );
}

/** "↑ 12%" in the success colour, "↓ 8%" in the danger colour. `change` is a ratio (0.12 = 12%). */
export function DeltaPill({ change }: { change: number }) {
  const up = change > 0;
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center gap-0.5 rounded-md px-1.5 text-label font-semibold tabular-nums',
        up ? 'bg-success-soft text-success-text' : 'bg-danger-soft text-danger-text',
      )}
    >
      {up ? <ArrowUpRight className="size-3" aria-hidden /> : <ArrowDownRight className="size-3" aria-hidden />}
      {Math.abs(Math.round(change * 100))}%
    </span>
  );
}
