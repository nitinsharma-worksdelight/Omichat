import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  BookOpen,
  Bot,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  Handshake,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Settings,
  ShieldQuestion,
  Users,
  Workflow,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { get, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useAction } from '../lib/mutations';
import { useOrg } from '../lib/queries';
import { appLink, Link, navigate, useRoute } from '../lib/router';
import type { AppNotification } from '../lib/types';
import { useApprovals } from './approvals';
import { MenuItem, Popover } from './overlay';
import { Badge, cx } from './ui';

const NAV = [
  { to: '/', segment: undefined, label: 'Overview', icon: LayoutDashboard },
  { to: '/bots', segment: 'bots', label: 'Bots', icon: Bot },
  { to: '/conversations', segment: 'conversations', label: 'Conversations', icon: MessagesSquare },
  { to: '/contacts', segment: 'contacts', label: 'Leads', icon: Users },
  { to: '/deals', segment: 'deals', label: 'Deals', icon: Handshake },
  { to: '/approvals', segment: 'approvals', label: 'Approvals', icon: ShieldQuestion },
  { to: '/knowledge', segment: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { to: '/appointments', segment: 'appointments', label: 'Appointments', icon: CalendarDays },
  { to: '/automations', segment: 'automations', label: 'Automations', icon: Workflow },
  { to: '/settings', segment: 'settings', label: 'Settings', icon: Settings },
] as const;

export function Layout({ children }: { children: ReactNode }) {
  const route = useRoute();
  const current = route.segments[0];
  const waiting = useApprovals({ status: 'pending' }).data?.length ?? 0;
  return (
    <div className="flex h-full min-w-[1024px]">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
          <div className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-fg">
            <MessageSquare className="size-4" aria-hidden />
          </div>
          <span className="text-sm font-semibold text-fg">Omni AI</span>
        </div>
        <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.map((item) => {
            const active = item.segment === current;
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                  active ? 'bg-accent-soft text-accent-text' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {item.label}
                {item.segment === 'approvals' && waiting > 0 && (
                  <Badge tone="amber" className="ml-auto">
                    {waiting > 99 ? '99+' : waiting}
                  </Badge>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function TopBar() {
  const { me, switchOrg, signOut } = useAuth();
  const org = useOrg();
  const memberships = me?.memberships ?? [];
  const orgName = org.data?.name ?? memberships.find((m) => m.organizationId === me?.currentOrganizationId)?.organizationName ?? '…';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6">
      <div className="flex min-w-0 items-center gap-3">
        {memberships.length > 1 ? (
          <Popover
            align="left"
            label="Switch organization"
            trigger={({ open, toggle, id }) => (
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                onClick={toggle}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm font-semibold text-fg hover:bg-surface-2"
              >
                <Building2 className="size-4 text-muted" aria-hidden />
                <span className="truncate">{orgName}</span>
                <ChevronDown className="size-3.5 text-muted" aria-hidden />
              </button>
            )}
          >
            {(close) => (
              <>
                <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">Organizations</p>
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
                    <span className="text-xs text-muted">{m.role}</span>
                  </MenuItem>
                ))}
              </>
            )}
          </Popover>
        ) : (
          <div className="flex items-center gap-2 px-2 text-sm font-semibold text-fg">
            <Building2 className="size-4 text-muted" aria-hidden />
            <span className="truncate">{orgName}</span>
          </div>
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
              className="flex items-center gap-2 rounded-md py-1 pr-1.5 pl-1 hover:bg-surface-2"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">
                {(me?.user.name || me?.user.email || '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="max-w-40 truncate text-[13px] font-medium text-fg">{me?.user.name || me?.user.email}</span>
              <ChevronDown className="size-3.5 text-muted" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="border-b border-border px-2.5 py-2">
                <p className="truncate text-[13px] font-medium text-fg">{me?.user.name || 'Signed in'}</p>
                <p className="truncate text-xs text-muted">{me?.user.email}</p>
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
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => get<AppNotification[]>('/v1/notifications'),
    refetchInterval: 30_000,
  });
  const markRead = useAction((ids: string[] | 'all') => post('/v1/notifications/read', { ids }), { invalidate: [['notifications']] });
  const items = notifications.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;

  return (
    <Popover
      label="Notifications"
      className="w-96 p-0"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={toggle}
          className="relative flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
        >
          <Bell className="size-4.5" aria-hidden />
          {unread > 0 && (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="text-[13px] font-semibold text-fg">Notifications</p>
            {unread > 0 && (
              <button type="button" className="text-xs font-medium text-accent-text hover:underline" onClick={() => markRead.mutate('all')}>
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-8 text-center text-[13px] text-muted">You're all caught up. Handoffs, qualified leads and new bookings show up here.</p>
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
                  className="flex w-full gap-2.5 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-2"
                >
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-accent')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={cx('block truncate text-[13px]', n.readAt ? 'text-fg-2' : 'font-medium text-fg')}>{n.title}</span>
                    {n.body && <span className="line-clamp-2 block text-xs text-muted">{n.body}</span>}
                    <span className="mt-0.5 block text-[11px] text-faint">{timeAgo(n.createdAt)}</span>
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
