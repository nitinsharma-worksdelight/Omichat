import { cx } from './ui';

/**
 * The Omni mark: a conversation ring in two strokes — iris for the AI, lagoon (with the speech tail) for the team —
 * on an ink tile. Brand colours are fixed, so they are written here rather than taken from the theme tokens.
 */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={cx('shrink-0', className)}>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" className="fill-[#1a1917] stroke-[#1a1917] dark:fill-[#1f2328] dark:stroke-[#343a42]" />
      <path d="M16 8.5a7.5 7.5 0 0 1 7.5 7.5" fill="none" stroke="#a898ff" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M23.5 16a7.5 7.5 0 0 1-7.5 7.5H9.6l1.7-2.4A7.5 7.5 0 0 1 16 8.5"
        fill="none"
        stroke="#3cc2bf"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mark plus the "Omni" wordmark and its small AI tag. */
export function BrandLockup({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <BrandMark size={size} />
      <span className="font-display text-[22px] leading-none font-semibold tracking-[-0.03em] text-fg">Omni</span>
      <span className="rounded-[5px] bg-ai-soft px-1.5 py-0.5 font-mono text-[10.5px] leading-none font-medium tracking-wide text-ai-text">AI</span>
    </span>
  );
}
