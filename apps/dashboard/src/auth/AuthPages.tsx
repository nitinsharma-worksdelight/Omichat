import { useState, type FormEvent, type ReactNode } from 'react';
import { api, session } from '../lib/api';
import { timezones } from '../lib/hooks';
import { Link } from '../lib/router';
import type { LoginResponse, SignupResponse } from '../lib/types';
import { BrandLockup } from '../components/brand';
import { Button, ErrorBanner, Field, Input, Select } from '../components/ui';
import { useAuth } from './AuthContext';

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-[400px]">
        <BrandLockup className="mb-10" />
        <h1 className="font-display text-display font-semibold tracking-[-0.025em] text-fg">{title}</h1>
        <p className="mt-1.5 text-body text-muted">{subtitle}</p>
        <div className="mt-7 rounded-2xl border border-border bg-surface p-7 shadow-card">{children}</div>
        <p className="mt-5 text-center text-body-sm text-muted">{footer}</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<LoginResponse>('/v1/auth/login', { method: 'POST', body: { email, password }, auth: false });
      const remembered = session.getOrgId();
      const orgId = res.memberships.some((m) => m.organizationId === remembered) ? remembered : (res.memberships[0]?.organizationId ?? null);
      signIn(res.token, orgId);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle="Manage your AI assistants, leads and bookings."
      footer={
        <>
          New here?{' '}
          <Link to="/signup" className="font-medium text-accent-text hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
        {import.meta.env.DEV && (
          <p className="text-center text-caption text-muted">
            Local demo: <code className="font-mono">demo@example.com</code> / <code className="font-mono">demo-password-123</code>
          </p>
        )}
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { signIn } = useAuth();
  const [form, setForm] = useState(() => ({
    name: '',
    email: '',
    password: '',
    organizationName: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<SignupResponse>('/v1/auth/signup', { method: 'POST', body: form, auth: false });
      signIn(res.token, res.organization.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your workspace"
      subtitle="You'll get a starter assistant, a knowledge base and a calendar."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent-text hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label="Your name">
          <Input autoComplete="name" value={form.name} onChange={(e) => set('name')(e.target.value)} />
        </Field>
        <Field label="Business name" required>
          <Input required value={form.organizationName} onChange={(e) => set('organizationName')(e.target.value)} />
        </Field>
        <Field label="Work email" required>
          <Input type="email" autoComplete="email" required value={form.email} onChange={(e) => set('email')(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 8 characters." required>
          <Input type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={(e) => set('password')(e.target.value)} />
        </Field>
        <Field label="Timezone">
          <Select value={form.timezone} onChange={(e) => set('timezone')(e.target.value)}>
            {timezones().map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
