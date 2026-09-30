import { lazy, Suspense, useEffect } from 'react';
import { useAuth } from './auth/AuthContext';
import { LoginPage, SignupPage } from './auth/AuthPages';
import { Layout } from './components/Layout';
import { Button, EmptyState, ErrorBanner, Spinner } from './components/ui';
import { LiveStreamProvider } from './lib/live';
import { navigate, useRoute } from './lib/router';
import { OverviewPage } from './pages/overview/OverviewPage';

// Pages load on demand so the first paint only needs the shell and the overview.
const AppointmentsPage = lazy(() => import('./pages/appointments/AppointmentsPage').then((m) => ({ default: m.AppointmentsPage })));
const AutomationsPage = lazy(() => import('./pages/automations/AutomationsPage').then((m) => ({ default: m.AutomationsPage })));
const BotEditorPage = lazy(() => import('./pages/bots/BotEditorPage').then((m) => ({ default: m.BotEditorPage })));
const BotsPage = lazy(() => import('./pages/bots/BotsPage').then((m) => ({ default: m.BotsPage })));
const ContactDetailPage = lazy(() => import('./pages/contacts/ContactDetailPage').then((m) => ({ default: m.ContactDetailPage })));
const ContactsPage = lazy(() => import('./pages/contacts/ContactsPage').then((m) => ({ default: m.ContactsPage })));
const ConversationsPage = lazy(() => import('./pages/conversations/ConversationsPage').then((m) => ({ default: m.ConversationsPage })));
const DealsPage = lazy(() => import('./pages/deals/DealsPage').then((m) => ({ default: m.DealsPage })));
const ApprovalsPage = lazy(() => import('./pages/approvals/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })));
const KnowledgePage = lazy(() => import('./pages/knowledge/KnowledgePage').then((m) => ({ default: m.KnowledgePage })));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));

export function App() {
  const { token, me, meLoading, meError, refetchMe, signOut } = useAuth();
  const route = useRoute();
  const first = route.segments[0];
  const isAuthRoute = first === 'login' || first === 'signup';

  useEffect(() => {
    if (!token && !isAuthRoute) navigate('/login', { replace: true });
    if (token && isAuthRoute) navigate('/', { replace: true });
  }, [token, isAuthRoute]);

  if (!token) return first === 'signup' ? <SignupPage /> : <LoginPage />;

  if (meLoading || (!me && !meError)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!me) {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col justify-center gap-4 px-4">
        <ErrorBanner error={meError} title="We couldn't load your account." />
        <div className="flex gap-2">
          <Button onClick={refetchMe}>Try again</Button>
          <Button variant="ghost" onClick={signOut}>
            Log out
          </Button>
        </div>
      </div>
    );
  }

  // One live connection for the signed-in dashboard (inbox events and notifications).
  return (
    <LiveStreamProvider>
      <Layout>
        <Suspense
          fallback={
            <div className="flex justify-center py-24">
              <Spinner />
            </div>
          }
        >
          <Routes />
        </Suspense>
      </Layout>
    </LiveStreamProvider>
  );
}

function Routes() {
  const route = useRoute();
  const [first, second, third] = route.segments;
  switch (first) {
    case undefined:
      return <OverviewPage />;
    case 'bots':
      return second ? <BotEditorPage key={second} botId={second} /> : <BotsPage />;
    case 'conversations':
      return <ConversationsPage conversationId={second ?? null} />;
    case 'contacts':
      return second ? <ContactDetailPage key={second} contactId={second} /> : <ContactsPage />;
    case 'deals':
      return <DealsPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'knowledge':
      return <KnowledgePage kbId={second ?? null} />;
    case 'appointments':
      return <AppointmentsPage view={second === 'calendars' ? 'calendars' : 'agenda'} calendarId={second === 'calendars' ? (third ?? null) : null} />;
    case 'automations':
      return <AutomationsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'login':
    case 'signup':
      return null;
    default:
      return (
        <EmptyState
          className="mt-24"
          title="Page not found"
          description="The link may be out of date."
          action={<Button onClick={() => navigate('/')}>Go to overview</Button>}
        />
      );
  }
}
