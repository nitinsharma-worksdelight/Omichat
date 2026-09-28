import { Check, ChevronDown, Copy, Loader2, X } from 'lucide-react';
import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { errorMessage, type ErrorDetail } from '../lib/api';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

// ---------- Button ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
type ButtonSize = 'xs' | 'sm' | 'md';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-fg-2 border border-transparent hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white border border-transparent hover:opacity-90',
  'danger-ghost': 'bg-transparent text-danger-text border border-transparent hover:bg-danger-soft',
};

const buttonSizes: Record<ButtonSize, string> = {
  xs: 'h-7 px-2 text-xs gap-1',
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, size = 'md', ...rest }: ComponentProps<'button'> & { label: string; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50',
        size === 'sm' ? 'size-7' : 'size-9',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- Form controls ----------

const FieldContext = createContext<{ id: string; describedBy?: string; invalid: boolean } | null>(null);

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
  /** Put the label beside the control (checkbox rows). */
  inline?: boolean;
}

/** Label + control + hint/error. Controls inside pick up the generated id automatically. */
export function Field({ label, hint, error, required, className, children, inline }: FieldProps) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy: hintId, invalid: Boolean(error) }}>
      <div className={cx(inline ? 'flex items-center gap-3' : 'flex flex-col gap-1.5', className)}>
        <label htmlFor={id} className="text-[13px] font-medium text-fg-2">
          {label}
          {required && <span className="ml-0.5 text-danger-text" aria-hidden>*</span>}
        </label>
        {children}
        {(error || hint) && (
          <p id={hintId} className={cx('text-xs', error ? 'text-danger-text' : 'text-muted')}>
            {error || hint}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

function useFieldProps(id: string | undefined, invalid: boolean | undefined) {
  const ctx = useContext(FieldContext);
  return {
    id: id ?? ctx?.id,
    'aria-describedby': ctx?.describedBy,
    'aria-invalid': invalid ?? ctx?.invalid ? true : undefined,
  };
}

export function Input({ className, id, invalid, ...rest }: ComponentProps<'input'> & { invalid?: boolean }) {
  const fieldProps = useFieldProps(id, invalid);
  return <input className={cx('control', className)} {...fieldProps} {...rest} />;
}

export function NumberInput({
  value,
  onChange,
  allowEmpty,
  className,
  ...rest
}: Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'> & {
  value: number | null;
  onChange: (value: number | null) => void;
  allowEmpty?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === null || value === undefined ? '' : String(value));
  return (
    <Input
      type="number"
      inputMode="decimal"
      className={className}
      value={shown}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === '') {
          if (allowEmpty) onChange(null);
          return;
        }
        const n = Number(raw);
        if (!Number.isNaN(n)) onChange(n);
      }}
      onBlur={() => setText(null)}
      {...rest}
    />
  );
}

export function Textarea({ className, id, invalid, ...rest }: ComponentProps<'textarea'> & { invalid?: boolean }) {
  const fieldProps = useFieldProps(id, invalid);
  return <textarea className={cx('control min-h-20 resize-y', className)} {...fieldProps} {...rest} />;
}

export function Select({ className, id, invalid, children, ...rest }: ComponentProps<'select'> & { invalid?: boolean }) {
  const fieldProps = useFieldProps(id, invalid);
  return (
    <div className={cx('relative', className)}>
      <select className="control appearance-none pr-8" {...fieldProps} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  size?: 'sm' | 'md';
  className?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
}

/** Accessible switch (role="switch"). With a label it renders as a labelled row. */
export function Toggle({ checked, onChange, label, description, disabled, id, size = 'md', className, ariaLabel }: ToggleProps) {
  const ctx = useContext(FieldContext);
  const autoId = useId();
  const controlId = id ?? (label ? autoId : ctx?.id ?? autoId);
  const button = (
    <button
      id={controlId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
        checked ? 'bg-accent' : 'bg-surface-3',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'inline-block rounded-full bg-white shadow-sm transition-transform',
          size === 'sm' ? 'size-3' : 'size-4',
          checked ? (size === 'sm' ? 'translate-x-3.5' : 'translate-x-4.5') : 'translate-x-0.5',
        )}
      />
    </button>
  );
  if (!label) return <span className={className}>{button}</span>;
  return (
    <div className={cx('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={controlId} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      {button}
    </div>
  );
}

export function Checkbox({ label, description, className, id, ...rest }: Omit<ComponentProps<'input'>, 'type'> & { label: ReactNode; description?: ReactNode }) {
  const autoId = useId();
  const cid = id ?? autoId;
  return (
    <div className={cx('flex items-start gap-2.5', className)}>
      <input id={cid} type="checkbox" className="mt-0.5 size-4 shrink-0 rounded accent-[var(--accent)]" {...rest} />
      <label htmlFor={cid} className="min-w-0 text-sm text-fg">
        {label}
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
    </div>
  );
}

// ---------- Chips input ----------

export interface ChipsInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  id?: string;
  /** Lower-case or otherwise normalise each chip before adding. */
  normalize?: (value: string) => string;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Type and press Enter (or comma) to add; Backspace on an empty input removes the last chip. */
export function ChipsInput({ value, onChange, placeholder, suggestions, id, normalize, disabled, ariaLabel }: ChipsInputProps) {
  const ctx = useContext(FieldContext);
  const [text, setText] = useState('');
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((s) => (normalize ? normalize(s.trim()) : s.trim()))
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const available = suggestions?.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()));
  return (
    <div
      className={cx(
        'flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2 py-1.5 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]',
        disabled && 'opacity-60',
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((chip) => (
        <span key={chip} className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-1 pl-2 text-[13px] text-fg">
          {chip}
          {!disabled && (
            <button
              type="button"
              className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-fg"
              aria-label={`Remove ${chip}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((v) => v !== chip));
              }}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        id={id ?? ctx?.id}
        aria-describedby={ctx?.describedBy}
        aria-label={ariaLabel}
        list={available?.length ? listId : undefined}
        className="min-w-24 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-faint"
        placeholder={value.length ? '' : placeholder}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          // Picking a datalist suggestion fires a change with the full value.
          if (available?.includes(v)) add(v);
          else setText(v);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => text && add(text)}
      />
      {available?.length ? (
        <datalist id={listId}>
          {available.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

// ---------- Layout bits ----------

export function Card({ className, children, ...rest }: ComponentProps<'div'>) {
  return (
    <div className={cx('rounded-lg border border-border bg-surface', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start justify-between gap-4 border-b border-border px-4 py-3', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, children, actions, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cx('space-y-4', className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/75">
      <div className="flex min-h-16 items-center justify-between gap-4 px-8 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-fg">{title}</h1>
          {description && <p className="truncate text-[13px] text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

// ---------- Status ----------

export type Tone = 'green' | 'amber' | 'red' | 'slate' | 'indigo' | 'blue';

const toneClasses: Record<Tone, string> = {
  green: 'bg-success-soft text-success-text',
  amber: 'bg-warning-soft text-warning-text',
  red: 'bg-danger-soft text-danger-text',
  slate: 'bg-surface-2 text-fg-2',
  indigo: 'bg-accent-soft text-accent-text',
  blue: 'bg-info-soft text-info-text',
};

export function Badge({ tone = 'slate', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', toneClasses[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cx('inline-flex items-center text-muted', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-surface-2', className)} aria-hidden />;
}

export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx('space-y-3 p-4', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-surface-2 text-muted">{icon}</div>}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ error, details, title, className, onRetry }: { error?: unknown; details?: ErrorDetail[]; title?: string; className?: string; onRetry?: () => void }) {
  if (!error && !details?.length) return null;
  return (
    <div role="alert" className={cx('rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{title ?? (error ? errorMessage(error) : 'Please fix the following')}</p>
        {onRetry && (
          <button type="button" className="shrink-0 underline" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
      {details && details.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
          {details.map((d, i) => (
            <li key={i}>
              {d.path && d.path !== 'config' && <code className="mr-1 font-mono text-xs">{d.path}</code>}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QueryState({ isLoading, error, onRetry, children, rows }: { isLoading: boolean; error: unknown; onRetry?: () => void; children: ReactNode; rows?: number }) {
  if (isLoading) return <SkeletonRows rows={rows} />;
  if (error) return <ErrorBanner error={error} onRetry={onRetry} className="m-4" />;
  return <>{children}</>;
}

// ---------- Table ----------

export function Table({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function TH({ className, children, ...rest }: ComponentProps<'th'>) {
  return (
    <th scope="col" className={cx('border-b border-border bg-surface-2/50 px-4 py-2 text-xs font-medium tracking-wide whitespace-nowrap text-muted uppercase', className)} {...rest}>
      {children}
    </th>
  );
}

export function TD({ className, children, ...rest }: ComponentProps<'td'>) {
  return (
    <td className={cx('border-b border-border px-4 py-2.5 align-middle', className)} {...rest}>
      {children}
    </td>
  );
}

// ---------- Tabs ----------

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  badge?: ReactNode;
  dot?: 'dirty' | 'error' | null;
}

export function Tabs<T extends string>({ tabs, value, onChange, className, ariaLabel }: { tabs: TabItem<T>[]; value: T; onChange: (id: T) => void; className?: string; ariaLabel?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const last = tabs.length - 1;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : index === 0 ? last : index - 1;
    const tab = tabs[next];
    if (tab) {
      onChange(tab.id);
      refs.current[next]?.focus();
    }
  };
  return (
    <div role="tablist" aria-label={ariaLabel} className={cx('flex items-center gap-1 overflow-x-auto', className)}>
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(
              'relative inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
              selected ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== null && <span className="rounded bg-surface-2 px-1.5 text-[11px] text-muted">{tab.badge}</span>}
            {tab.dot && (
              <span
                className={cx('size-1.5 rounded-full', tab.dot === 'error' ? 'bg-danger' : 'bg-warning')}
                aria-label={tab.dot === 'error' ? 'has errors' : 'unsaved changes'}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Misc ----------

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label = 'Copy', size = 'sm', variant = 'secondary' }: { text: string; label?: string; size?: ButtonSize; variant?: ButtonVariant }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function CodeBlock({ children, className }: { children: string; className?: string }) {
  return <pre className={cx('prose-pre overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 text-fg-2', className)}>{children}</pre>;
}

/** JSON collapsed behind a disclosure by default. */
export function JsonDisclosure({ label, value, defaultOpen }: { label: string; value: unknown; defaultOpen?: boolean }) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3 -rotate-90 transition-transform group-open:rotate-0" aria-hidden />
        {label}
      </summary>
      <pre className="prose-pre mt-1 max-h-72 overflow-auto rounded-md bg-surface-2 p-2 text-fg-2">{JSON.stringify(value, null, 2) ?? 'null'}</pre>
    </details>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[11px] text-muted">{children}</kbd>;
}

export function DefinitionList({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
