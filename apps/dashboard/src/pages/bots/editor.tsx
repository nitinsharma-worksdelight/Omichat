import { Check, ChevronRight, CircleAlert, Code, Save, Search, Undo2, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogBehaviour } from '../../components/overlay';
import { Badge, Button, cx, Kbd } from '../../components/ui';
import type { ErrorDetail } from '../../lib/api';
import { navigate } from '../../lib/router';
import {
  errorText,
  essentials,
  moreSettings,
  OVERVIEW,
  searchSettings,
  SECTION_GROUPS,
  sectionInfo,
  sectionOfError,
  sectionStatus,
  type BotDraft,
  type EditorView,
  type Essential,
  type SectionId,
  type SectionStatus,
} from './editorNav';
import type { EditorContext } from './sections';

/** The bot editor's own pieces: the grouped settings menu, the overview, settings search, the save bar and save errors. */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const SEARCH_SHORTCUT = isMac ? '⌘K' : 'Ctrl K';

// ---------- Menu ----------

function MenuButton({
  selected,
  icon: Icon,
  label,
  status,
  mark,
  onClick,
}: {
  selected: boolean;
  icon: LucideIcon;
  label: string;
  status: SectionStatus | null;
  mark: 'error' | 'dirty' | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      className={cx(
        'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-body-sm transition-colors',
        selected ? 'bg-accent-soft font-semibold text-accent-text' : 'font-medium text-fg-2 hover:bg-surface-2 hover:text-fg',
      )}
    >
      <Icon className={cx('size-4 shrink-0', selected ? 'text-accent-text' : 'text-muted')} aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      {status && (
        <span
          className={cx(
            'shrink-0 rounded-full px-1.5 text-label leading-[18px] font-semibold',
            status.tone === 'on' ? 'bg-success-soft text-success-text' : status.tone === 'off' ? 'bg-surface-2 text-muted' : 'bg-surface-2 text-fg-2',
          )}
        >
          {status.label}
        </span>
      )}
      {mark === 'error' && (
        <>
          <CircleAlert className="size-3.5 shrink-0 text-danger" aria-hidden />
          <span className="sr-only">, needs fixing</span>
        </>
      )}
      {mark === 'dirty' && (
        <>
          <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
          <span className="sr-only">, unsaved changes</span>
        </>
      )}
    </button>
  );
}

export function SettingsMenu({
  view,
  onSelect,
  onSearch,
  draft,
  assistantName,
  progress,
  dirty,
  errors,
}: {
  view: EditorView;
  onSelect: (view: EditorView) => void;
  onSearch: () => void;
  draft: BotDraft;
  assistantName: string;
  /** "4/6" for the overview; null while it's being worked out. */
  progress: string | null;
  dirty: ReadonlySet<SectionId>;
  errors: ReadonlySet<SectionId>;
}) {
  return (
    <nav aria-label="Bot settings" className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar px-3 py-4 md:flex xl:w-64">
      <button
        type="button"
        onClick={onSearch}
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        className="mb-3 flex h-9 w-full shrink-0 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-left text-body-sm text-muted transition-colors hover:border-border-strong hover:text-fg-2"
      >
        <Search className="size-3.5 shrink-0" aria-hidden />
        <span className="flex-1">Search settings</span>
        <Kbd>{SEARCH_SHORTCUT}</Kbd>
      </button>
      <MenuButton
        selected={view === 'overview'}
        icon={OVERVIEW.icon}
        label={OVERVIEW.label}
        status={progress ? { label: progress, tone: 'neutral' } : null}
        mark={null}
        onClick={() => onSelect('overview')}
      />
      {SECTION_GROUPS.map((group) => (
        <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`} className="mt-4 flex flex-col gap-0.5">
          <p id={`settings-group-${group.id}`} className="truncate px-2.5 pb-1 text-label font-semibold tracking-wide text-muted uppercase">
            {group.label(assistantName)}
          </p>
          {group.sections.map((s) => (
            <MenuButton
              key={s.id}
              selected={view === s.id}
              icon={s.icon}
              label={s.label}
              status={sectionStatus(s.id, draft)}
              mark={errors.has(s.id) ? 'error' : dirty.has(s.id) ? 'dirty' : null}
              onClick={() => onSelect(s.id)}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

// ---------- Overview ----------

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 26;
  const circumference = 2 * Math.PI * r;
  const filled = total ? (done / total) * circumference : 0;
  return (
    <div role="img" aria-label={`${done} of ${total} essentials set up`} className="relative size-16 shrink-0">
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="7" className="stroke-surface-3" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          className={cx('transition-[stroke-dasharray] duration-300 motion-reduce:transition-none', done === total ? 'stroke-success' : 'stroke-accent')}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-body font-bold text-fg tabular-nums">
        {done}/{total}
      </span>
    </div>
  );
}

function EssentialCard({ item, onOpen }: { item: Essential; onOpen: (section: SectionId) => void }) {
  const Icon = item.icon;
  return (
    <article className={cx('flex flex-col gap-3 rounded-xl border bg-surface p-4', item.done ? 'border-border' : 'border-accent/40')}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          <Icon className="size-4.5" aria-hidden />
        </span>
        {item.done ? (
          <Badge tone="green">
            <Check className="size-3" aria-hidden />
            Done
          </Badge>
        ) : (
          <Badge tone="amber">To do</Badge>
        )}
      </div>
      <div className="space-y-1">
        <h4 className="text-body font-semibold text-fg">{item.title}</h4>
        <p className="text-body-sm leading-5 text-muted">{item.summary}</p>
        {item.warning && <p className="text-body-sm leading-5 font-medium text-warning-text">{item.warning}</p>}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1">
        {item.done ? (
          <button type="button" onClick={() => onOpen(item.section)} aria-label={`Edit ${item.title}`} className="text-body-sm font-semibold text-accent-text hover:underline">
            Edit
          </button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => onOpen(item.section)}>
            {item.action}
          </Button>
        )}
        {item.also && (
          <button type="button" onClick={() => onOpen(item.also!.section)} className="text-body-sm font-medium text-muted hover:text-fg hover:underline">
            {item.also.label}
          </button>
        )}
      </div>
    </article>
  );
}

export function EditorOverview({
  draft,
  ctx,
  onOpen,
  onTestChat,
}: {
  draft: BotDraft;
  ctx: EditorContext;
  onOpen: (section: SectionId) => void;
  /** Opens the test chat; null when it's already open. */
  onTestChat: (() => void) | null;
}) {
  const name = draft.config.persona.assistantName.trim() || 'Your assistant';
  const list = essentials(draft, ctx);
  const done = list.filter((e) => e.done).length;
  const next = list.find((e) => !e.done);
  const NextIcon = next?.icon;
  const title = !next ? `${name} is ready to chat` : done * 2 >= list.length ? `${name} is almost ready` : `Let's get ${name} ready`;
  return (
    <div className="space-y-7">
      <section aria-labelledby="overview-title" className="flex items-center gap-5 rounded-2xl border border-border bg-surface p-5">
        <ProgressRing done={done} total={list.length} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 id="overview-title" className="text-xl font-semibold tracking-tight text-fg">
            {title}
          </h2>
          <p className="text-body leading-6 text-fg-2">
            {next
              ? `${done} of ${list.length} essentials are set up. ${next.nextStep}`
              : 'Everything essential is set up. Fine-tune anything below, or try a test chat.'}
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            {next && NextIcon ? (
              <Button variant="primary" icon={<NextIcon className="size-4" aria-hidden />} onClick={() => onOpen(next.section)}>
                {next.action}
              </Button>
            ) : (
              onTestChat && (
                <Button variant="primary" onClick={onTestChat}>
                  Try a test chat
                </Button>
              )
            )}
            <Button icon={<Code className="size-4" aria-hidden />} onClick={() => navigate('/settings?tab=channels')}>
              Get the website code
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="essentials-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 id="essentials-title" className="text-body font-semibold text-fg">
            Essentials
          </h3>
          <p className="text-body-sm text-muted">The parts that shape every chat.</p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
          {list.map((item) => (
            <EssentialCard key={item.id} item={item} onOpen={onOpen} />
          ))}
        </div>
      </section>

      {ctx.warnings.length > 0 && (
        <section aria-labelledby="checking-title" className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 id="checking-title" className="text-body font-semibold text-fg">
              Worth checking
            </h3>
            <p className="text-body-sm text-muted">Saving still works; these are what visitors could be told wrong.</p>
          </div>
          <ul className="space-y-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
            {ctx.warnings.map((w) => (
              <li key={w.id} className="flex items-start gap-3 text-body-sm leading-5 text-warning-text">
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{sectionInfo(w.section).label} · </span>
                  {w.message}
                </span>
                <button type="button" onClick={() => onOpen(w.section)} className="shrink-0 font-semibold hover:underline">
                  Go to it
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="more-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 id="more-title" className="text-body font-semibold text-fg">
            More settings
          </h3>
          <p className="text-body-sm text-muted">Fine-tune {name} when you need to.</p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
          {moreSettings(draft, ctx).map((row) => {
            const info = sectionInfo(row.section);
            const Icon = info.icon;
            return (
              <button
                key={row.section}
                type="button"
                onClick={() => onOpen(row.section)}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-2">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body-sm font-semibold text-fg">{info.label}</span>
                  <span className="block truncate text-caption text-muted">{row.summary}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ---------- A section's heading ----------

/** Above a section's settings: its group, its name and what it's for. */
export function SectionHeader({ section, assistantName }: { section: SectionId; assistantName: string }) {
  const group = SECTION_GROUPS.find((g) => g.sections.some((s) => s.id === section));
  const info = sectionInfo(section);
  return (
    <div className="space-y-1 pb-1">
      {group && <p className="text-caption font-semibold tracking-wider text-muted uppercase">{group.label(assistantName)}</p>}
      <h2 className="font-display text-title font-semibold tracking-[-0.02em] text-fg">{info.label}</h2>
      <p className="text-body leading-6 text-muted">{info.description(assistantName)}</p>
    </div>
  );
}

// ---------- Settings search ----------

/** Where a search result leads: a section, and the setting in it to jump to (null = the section's top). */
export interface SettingsTarget {
  view: EditorView;
  setting: string | null;
}

interface SettingsSearchProps {
  onClose: () => void;
  onSelect: (target: SettingsTarget) => void;
  assistantName: string;
}

/** Each opening starts afresh (an empty box, the first result), before anything is typed. */
export function SettingsSearch({ open, ...props }: SettingsSearchProps & { open: boolean }) {
  return open ? <SearchDialog {...props} /> : null;
}

function SearchDialog({ onClose, onSelect, assistantName }: SettingsSearchProps) {
  const panelRef = useDialogBehaviour(true, onClose);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchSettings(query, assistantName), [query, assistantName]);

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    onSelect({ view: r.view, setting: r.setting });
    onClose();
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-overlay p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        data-dialog-panel
        role="dialog"
        aria-modal="true"
        aria-label="Search settings"
        tabIndex={-1}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop outline-none"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted" aria-hidden />
          <input
            data-autofocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
            aria-label="Search settings"
            placeholder="Search settings, like greeting or calendar"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!results.length) return;
                setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % results.length : (i - 1 + results.length) % results.length));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(active);
              }
            }}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-muted"
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Settings" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.map((r, i) => {
            const Icon = r.icon;
            return (
              <li
                key={r.setting ?? r.view}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(i)}
                className={cx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2', i === active ? 'bg-accent-soft' : '')}
              >
                <span
                  className={cx(
                    'flex size-8 shrink-0 items-center justify-center rounded-lg',
                    i === active ? 'bg-surface text-accent-text' : 'bg-surface-2 text-fg-2',
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-fg">{r.label}</span>
                  <span className="block truncate text-caption text-muted">
                    {r.where}
                    {r.matched ? ` · matches “${r.matched}”` : ''}
                  </span>
                </span>
              </li>
            );
          })}
          {!results.length && <li className="px-3 py-8 text-center text-body-sm text-muted">No settings match “{query.trim()}”.</li>}
        </ul>
        <div className="flex items-center gap-4 border-t border-border bg-bg px-4 py-2 text-caption text-muted">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd>Move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd>Open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd>Close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Saving ----------

export function SaveBar({
  changes,
  saving,
  canSave,
  onDiscard,
  onSave,
}: {
  /** What changed, by name ("Identity & voice", "Status"). */
  changes: string[];
  saving: boolean;
  canSave: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-xl border border-border bg-surface py-2.5 pr-2.5 pl-4 shadow-pop"
    >
      <span className="size-2.5 shrink-0 rounded-full bg-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body-sm font-semibold text-fg">{changes.length === 1 ? '1 unsaved change' : `${changes.length} unsaved changes`}</p>
        <p className="truncate text-caption text-muted">{changes.join(' · ')}</p>
      </div>
      <Button size="sm" icon={<Undo2 className="size-3.5" aria-hidden />} disabled={saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button
        size="sm"
        variant="primary"
        icon={<Save className="size-3.5" aria-hidden />}
        loading={saving}
        disabled={!canSave}
        title={canSave ? undefined : 'Only admins can change bots'}
        onClick={onSave}
      >
        Save changes
      </Button>
    </div>
  );
}

/** A field path as people read it: `conversationStarters.4.label` → "#5 › label". */
function pathHint(path: string): string {
  const parts = (path.startsWith('config.') ? path.slice(7) : path).split('.').slice(1);
  return parts.map((p) => (/^\d+$/.test(p) ? `#${Number(p) + 1}` : p)).join(' › ');
}

/** Why a save failed, one line per problem, each with a way to the section it's in. */
export function SaveErrors({ details, view, onOpen }: { details: ErrorDetail[]; view: EditorView; onOpen: (section: SectionId) => void }) {
  return (
    <div role="alert" className="space-y-2 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3">
      <p className="flex items-center gap-2 text-body font-semibold text-danger-text">
        <CircleAlert className="size-4 shrink-0" aria-hidden />
        Not saved yet: {details.length === 1 ? '1 thing to fix' : `${details.length} things to fix`}
      </p>
      <ul className="space-y-1.5 pl-6">
        {details.map((d, i) => {
          const section = sectionOfError(d);
          const hint = pathHint(d.path);
          return (
            <li key={i} className="flex items-start gap-3 text-body-sm leading-5 text-fg-2">
              <span className="min-w-0 flex-1">
                {section && <span className="font-semibold text-fg">{sectionInfo(section).label} · </span>}
                {errorText(d)}
                {hint && <span className="ml-1.5 font-mono text-caption text-muted">{hint}</span>}
              </span>
              {section && section !== view && (
                <button type="button" onClick={() => onOpen(section)} className="shrink-0 font-semibold text-danger-text hover:underline">
                  Go to it
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
