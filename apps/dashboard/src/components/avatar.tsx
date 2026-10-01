import { Sparkles, UserRound } from 'lucide-react';
import { initialsOf } from '../lib/format';
import { cx } from './ui';

type AvatarSize = 'sm' | 'md' | 'lg';

const sizes: Record<AvatarSize, string> = {
  sm: 'size-6 text-[10px] [&_svg]:size-3',
  md: 'size-7 text-label [&_svg]:size-3.5',
  lg: 'size-8.5 text-caption [&_svg]:size-4',
};

/**
 * A person: initials in a circle. `human` marks your team (apricot); visitors stay neutral. No name means an
 * anonymous visitor (a dashed circle with a person icon). Decorative: the name is always written next to it.
 */
export function PersonAvatar({ name, tone = 'neutral', size = 'md', className }: { name?: string | null; tone?: 'neutral' | 'human'; size?: AvatarSize; className?: string }) {
  // A phone number as the name gives no useful initials: show the person icon instead.
  const initials = name && /\p{L}/u.test(name) ? initialsOf(name).replace(/[^\p{L}]/gu, '') : '';
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
        sizes[size],
        !name
          ? 'border border-dashed border-border-strong bg-surface-2 text-muted'
          : tone === 'human'
            ? 'bg-human-soft text-human-text ring-1 ring-human/40'
            : 'bg-surface-3 text-fg-2',
        className,
      )}
    >
      {initials || <UserRound />}
    </span>
  );
}

/** The assistant: a rounded square in iris with a sparkle, so it never reads as a person. */
export function AiAvatar({ size = 'md', className }: { size?: AvatarSize; className?: string }) {
  return (
    <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center rounded-lg bg-ai-soft text-ai', sizes[size], className)}>
      <Sparkles />
    </span>
  );
}
