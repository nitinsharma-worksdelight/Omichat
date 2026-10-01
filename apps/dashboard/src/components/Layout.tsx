import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BookOpen,
  Bot,
  CalendarDays,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Handshake,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldQuestion,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { get, post } from '../lib/api';
import { initialsOf, timeAgo } from '../lib/format';
import { useAction } from '../lib/mutations';
import { useOrg } from '../lib/queries';
import { useLiveEvents } from '../lib/live';
import { appLink, currentPath, Link, navigate, useRoute } from '../lib/router';
import { BrandMark } from './brand';
import { ThemeToggle } from './theme';
import { useToast } from './feedback-context';
import type { AppNotification } from '../lib/types';
import { useApprovals } from './approvals';
import { MenuItem, Popover } from './overlay';
import { Badge, cx } from './ui';

interface NavItem {
  to: string;
  segment: string | undefined;
  label: string;
  icon: LucideIcon;
}

// The same destinations as ever, grouped into sections; Settings sits apart at the bottom of the menu.
const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Home',
    items: [
      { to: '/', segment: undefined, label: 'Overview', icon: LayoutDashboard },
      { to: '/analytics', segment: 'analytics', label: 'Analytics', icon: ChartColumn },
    ],
  },
  {
    label: 'AI Studio',
    items: [
      { to: '/bots', segment: 'bots', label: 'Bots', icon: Bot },
      { to: '/knowledge', segment: 'knowledge', label: 'Knowledge', icon: BookOpen },
    ],
  },
  {
    label: 'Inbox',
    items: [
      { to: '/conversations', segment: 'conversations', label: 'Conversations', icon: MessagesSquare },
      { to: '/approvals', segment: 'approvals', label: 'Approvals', icon: ShieldQuestion },
    ],
  },
  {
    label: 'Customers',
    items: [
      { to: '/contacts', segment: 'contacts', label: 'Leads', icon: Users },
      { to: '/deals', segment: 'deals', label: 'Deals', icon: Handshake },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/appointments', segment: 'appointments', label: 'Appointments', icon: CalendarDays },
      { to: '/automations', segment: 'automations', label: 'Automations', icon: Workflow },
    ],
  },
];
const SETTINGS_ITEM: NavItem = { to: '/settings', segment: 'settings', label: 'Settings', icon: Settings };

/** "Section › Page" for the top bar, from the first route segment (none for an unknown page). */
function breadcrumbFor(segment: string | undefined): string[] {
  if (segment === SETTINGS_ITEM.segment) return [SETTINGS_ITEM.label];
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.segment === segment);
    if (item) return [group.label, item.label];
  }
  return [];
}

/** A yes/no kept in this browser (and still working, just not remembered, where storage is blocked). `fallback` is used until a choice is stored. */
function useStoredFlag(key: string, fallback: () => boolean = () => false): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback() : stored === '1';
    } catch {
      return fallback();
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? '1' : '0');
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  };
  return [value, set];
}

/** Whether a CSS media query matches, following changes (window resizes, rotation). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function Layout({ children }: { children: ReactNode }) {
  const route = useRoute();
  const current = route.segments[0];
  const waiting = useApprovals({ status: 'pending' }).data?.length ?? 0;
  // From 1024 px the menu sits beside the page; below, it slides over it from a button in the top bar.
  const desktop = useMediaQuery('(min-width: 1024px)');
  // Icons only when collapsed: one choice for every page, remembered in this browser (the shell stays mounted as pages
  // change). Until someone chooses, narrower screens (below 1280 px) start with the icons.
  const [collapsed, setCompact] = useStoredFlag('omni:main-menu-collapsed', () => window.innerWidth < 1280);
  const compact = desktop && collapsed;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const routeKey = route.segments.join('/');
  // Opening a page closes the slide-over menu.
  useEffect(() => setMenuOpen(false), [routeKey]);
  useEffect(() => {
    if (desktop || !menuOpen) return;
    document.querySelector<HTMLElement>('#main-menu a, #main-menu button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [desktop, menuOpen]);
  const slideOver = !desktop;
  return (
    <div className="flex h-full">
      {slideOver && menuOpen && <div className="fixed inset-0 z-40 bg-overlay" aria-hidden onClick={() => setMenuOpen(false)} />}
      <aside
        id="main-menu"
        // Off screen, the menu is out of the tab order and hidden from screen readers.
        inert={slideOver && !menuOpen ? true : undefined}
        className={cx(
          'flex shrink-0 flex-col border-r border-border bg-sidebar',
          slideOver
            ? cx('fixed inset-y-0 left-0 z-50 w-62 shadow-modal transition-transform duration-200 motion-reduce:transition-none', menuOpen ? 'translate-x-0' : '-translate-x-full')
            : compact
              ? 'w-16'
              : 'w-62',
        )}
      >
        <OrgSwitcher compact={compact} />
        <nav aria-label="Main" className={cx('flex-1 overflow-y-auto pb-2', compact ? 'px-2 pt-1' : 'px-2.5 pt-1')}>
          {NAV_GROUPS.map((group, index) => (
            <NavGroup key={group.label} label={group.label} first={index === 0} compact={compact}>
              {group.items.map((item) => (
                <NavLink key={item.to} item={item} active={item.segment === current} compact={compact} waiting={item.segment === 'approvals' ? waiting : 0} />
              ))}
            </NavGroup>
          ))}
        </nav>
        <div className={cx('space-y-0.5 border-t border-border py-2', compact ? 'px-2' : 'px-2.5')}>
          <NavLink item={SETTINGS_ITEM} active={current === SETTINGS_ITEM.segment} compact={compact} waiting={0} />
          <ThemeToggle compact={compact} />
          {slideOver ? (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                menuButton.current?.focus();
              }}
              className="flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-body-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-4 shrink-0" aria-hidden />
              Close menu
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCompact(!compact)}
              aria-expanded={!compact}
              aria-controls="main-menu"
              aria-label={compact ? 'Expand menu' : 'Collapse menu'}
              title={compact ? 'Expand menu' : 'Collapse menu'}
              className={cx(
                'flex items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg',
                compact ? 'mx-auto size-10 justify-center' : 'h-8.5 w-full gap-2.5 px-2.5 text-body-sm font-medium',
              )}
            >
              {compact ? (
                <PanelLeftOpen className="size-4" aria-hidden />
              ) : (
                <>
                  <PanelLeftClose className="size-4 shrink-0" aria-hidden />
                  Collapse menu
                </>
              )}
            </button>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          breadcrumb={breadcrumbFor(current)}
          menu={
            slideOver ? (
              <button
                ref={menuButton}
                type="button"
                aria-label="Open menu"
                aria-expanded={menuOpen}
                aria-controls="main-menu"
                onClick={() => setMenuOpen(true)}
                className="-ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <Menu className="size-5" aria-hidden />
              </button>
            ) : null
          }
        />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function NavGroup({ label, first, compact, children }: { label: string; first: boolean; compact: boolean; children: ReactNode }) {
  const id = useId();
  if (compact) {
    return (
      <div role="group" aria-label={label} className="space-y-0.5">
        {!first && <div className="mx-auto my-2 h-px w-6 bg-border" aria-hidden />}
        {children}
      </div>
    );
  }
  return (
    <div role="group" aria-labelledby={id} className="space-y-0.5">
      <p id={id} className={cx('px-2.5 pb-1 text-[10.5px] leading-4 font-semibold tracking-[0.08em] text-muted uppercase', first ? 'pt-3' : 'pt-4')}>
        {label}
      </p>
      {children}
    </div>
  );
}

function NavLink({ item, active, compact, waiting }: { item: NavItem; active: boolean; compact: boolean; waiting: number }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      title={compact ? item.label : undefined}
      className={cx(
        'flex items-center rounded-lg text-body-sm transition-colors',
        compact ? 'relative mx-auto size-10 justify-center' : 'h-8.5 gap-2.5 px-2.5',
        active ? 'bg-accent-soft font-semibold text-accent-text' : 'font-medium text-fg-2 hover:bg-surface-2 hover:text-fg',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {compact ? <span className="sr-only">{item.label}</span> : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {waiting > 0 &&
        (compact ? (
          <>
            <span className="absolute top-2 right-2 size-2 rounded-full bg-warning ring-2 ring-sidebar" aria-hidden />
            <span className="sr-only">, {waiting} waiting</span>
          </>
        ) : (
          <Badge tone="amber" className="h-5 px-1.5 text-label tabular-nums">
            {waiting > 99 ? '99+' : waiting}
          </Badge>
        ))}
    </Link>
  );
}

/** The sidebar's head: the mark plus the organization, which opens the switcher when there is more than one. */
function OrgSwitcher({ compact }: { compact: boolean }) {
  const { me, switchOrg } = useAuth();
  const org = useOrg();
  const memberships = me?.memberships ?? [];
  const orgName = org.data?.name ?? memberships.find((m) => m.organizationId === me?.currentOrganizationId)?.organizationName ?? '…';
  const identity = compact ? (
    <>
      <BrandMark size={30} />
      <span className="sr-only">{orgName}</span>
    </>
  ) : (
    <>
      <BrandMark size={30} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-body-sm font-semibold text-fg">{orgName}</span>
        <span className="block truncate text-label text-muted">Omni AI{me?.role ? ` · ${me.role.charAt(0).toUpperCase()}${me.role.slice(1)}` : ''}</span>
      </span>
    </>
  );
  const frame = cx('flex h-16 shrink-0 items-center border-b border-border', compact ? 'justify-center' : 'px-2.5 [&>div]:w-full');

  if (memberships.length <= 1) {
    return (
      <div className={frame}>
        <div className={cx('flex min-w-0 items-center gap-2.5', !compact && 'w-full px-2')}>{identity}</div>
      </div>
    );
  }
  return (
    <div className={frame}>
      <Popover
        align="left"
        label="Switch organization"
        className={compact ? undefined : 'w-full'}
        trigger={({ open, toggle, id }) => (
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            aria-label={compact ? `Switch organization (${orgName})` : undefined}
            title={compact ? orgName : undefined}
            onClick={toggle}
            className={cx(
              'flex items-center gap-2.5 rounded-lg transition-colors hover:bg-surface-2',
              compact ? 'size-10 justify-center' : 'w-full px-2 py-1.5',
              open && 'bg-surface-2',
            )}
          >
            {identity}
            {!compact && <ChevronsUpDown className="size-3.5 shrink-0 text-muted" aria-hidden />}
          </button>
        )}
      >
        {(close) => (
          <>
            <p className="px-2.5 pt-1.5 pb-1 text-label font-semibold tracking-[0.06em] text-muted uppercase">Organizations</p>
            {memberships.map((m) => (
              <MenuItem
                key={m.organizationId}
                icon={m.organizationId === me?.currentOrganizationId ? <Check className="size-3.5" /> : <span className="inline-block size-3.5" />}
                onClick={() => {
                  close();
                  if (m.organizationId !== me?.currentOrganizationId) switchOrg(m.organizationId);
                }}
              >
                <span className="flex-1 truncate">{m.organizationName}</span>
                <span className="text-caption text-muted">{m.role}</span>
              </MenuItem>
            ))}
          </>
        )}
      </Popover>
    </div>
  );
}

function TopBar({ breadcrumb, menu }: { breadcrumb: string[]; menu: ReactNode }) {
  const { me, signOut } = useAuth();
  const org = useOrg();
  const displayName = me?.user.name || me?.user.email || '';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-bg px-4 sm:px-8">
      <div className="flex min-w-0 items-center gap-3">
        {menu}
        {breadcrumb.length > 0 && (
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex items-center gap-1.5 text-body-sm text-muted">
              {breadcrumb.map((part, i) => {
                const last = i === breadcrumb.length - 1;
                return (
                  <li key={part} className="flex min-w-0 items-center gap-1.5">
                    {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />}
                    <span aria-current={last ? 'page' : undefined} className={cx('truncate', last && 'font-medium text-fg')}>
                      {part}
                    </span>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        {org.data && !org.data.aiEnabled && (
          <Link to="/settings">
            <Badge tone="amber" dot>
              AI paused
            </Badge>
          </Link>
        )}
      </div>
      <div className="flex items-center gap-1">
        <NotificationsBell />
        <Popover
          label="Account"
          trigger={({ open, toggle, id }) => (
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? id : undefined}
              onClick={toggle}
              className={cx('flex items-center gap-2 rounded-lg py-1 pr-2 pl-1 transition-colors hover:bg-surface-2', open && 'bg-surface-2')}
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-human-soft text-label font-semibold text-human-text" aria-hidden>
                {initialsOf(displayName) || '?'}
              </span>
              <span className="hidden max-w-40 truncate text-body-sm font-medium text-fg sm:block">{displayName}</span>
              <ChevronDown className="size-3.5 text-muted" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="border-b border-border px-2.5 pt-1.5 pb-2.5">
                <p className="truncate text-body-sm font-semibold text-fg">{me?.user.name || 'Signed in'}</p>
                <p className="truncate text-caption text-muted">{me?.user.email}</p>
                {me?.role && (
                  <Badge className="mt-1.5" tone="slate">
                    {me.role}
                  </Badge>
                )}
              </div>
              <div className="pt-1">
                <MenuItem
                  icon={<Settings className="size-3.5" />}
                  onClick={() => {
                    close();
                    navigate('/settings');
                  }}
                >
                  Settings
                </MenuItem>
                <MenuItem
                  icon={<LogOut className="size-3.5" />}
                  onClick={() => {
                    close();
                    signOut();
                  }}
                >
                  Log out
                </MenuItem>
              </div>
            </>
          )}
        </Popover>
      </div>
    </header>
  );
}

function NotificationsBell() {
  const qc = useQueryClient();
  const toast = useToast();
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => get<AppNotification[]>('/v1/notifications'),
    // The live stream brings new ones at once; the poll and the refetch on returning to the tab are the fallback.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  useLiveEvents(
    (event, data) => {
      if (event !== 'notification') return;
      const id = (data as { id?: string } | null)?.id;
      void qc.fetchQuery({ queryKey: ['notifications'], queryFn: () => get<AppNotification[]>('/v1/notifications') }).then((list) => {
        const n = list.find((x) => x.id === id);
        // No toast for one already read, or for the conversation already on screen.
        const to = appLink(n?.link);
        if (!n || n.readAt || (to && currentPath() === to)) return;
        toast.notify({
          title: n.title,
          body: n.body,
          actionLabel: to ? 'Open' : undefined,
          onAction: to
            ? () => {
                markRead.mutate([n.id]);
                navigate(to);
              }
            : undefined,
        });
      });
    },
    // Catch up on anything that arrived while the stream was down.
    () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  );
  const markRead = useAction((ids: string[] | 'all') => post('/v1/notifications/read', { ids }), { invalidate: [['notifications']] });
  const items = notifications.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;

  return (
    <Popover
      label="Notifications"
      className="w-96 overflow-hidden p-0!"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={toggle}
          className="relative flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Bell className="size-4.5" aria-hidden />
          {unread > 0 && (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-danger-fg tabular-nums ring-2 ring-bg">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
            <p className="text-body-sm font-semibold text-fg">Notifications</p>
            {unread > 0 && (
              <button type="button" className="text-caption font-medium text-accent-text hover:underline" onClick={() => markRead.mutate('all')}>
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-10 text-center text-body-sm text-muted">You're all caught up. Handoffs, qualified leads and new bookings show up here.</p>
            ) : (
              items.slice(0, 30).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (!n.readAt) markRead.mutate([n.id]);
                    const to = appLink(n.link);
                    close();
                    if (to) navigate(to);
                  }}
                  className="flex w-full gap-2.5 border-b border-border px-3.5 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-2"
                >
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-accent')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={cx('block truncate text-body-sm', n.readAt ? 'text-fg-2' : 'font-semibold text-fg')}>{n.title}</span>
                    {n.body && <span className="mt-0.5 line-clamp-3 block whitespace-pre-line text-caption text-muted">{n.body}</span>}
                    <span className="mt-1 block text-label text-muted">{timeAgo(n.createdAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
