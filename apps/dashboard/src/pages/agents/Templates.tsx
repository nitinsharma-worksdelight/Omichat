import { CalendarCheck, ConciergeBell, Headset, Search, TrendingUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Button, cx, EmptyState, ErrorBanner } from '../../components/ui';
import { roleAtLeast, useKnowledgeBases } from '../../lib/queries';
import { PERSONALITY_TEMPLATES, type PersonalityTemplate } from '../bots/sections';
import { useCreateAgent } from './CreateAgentModal';
import { agentPreset } from './shared';

const CATEGORY: Record<string, { name: string; icon: ReactNode }> = {
  receptionist: { name: 'Reception', icon: <ConciergeBell className="size-9" strokeWidth={1.5} /> },
  sales: { name: 'Sales', icon: <TrendingUp className="size-9" strokeWidth={1.5} /> },
  support: { name: 'Support', icon: <Headset className="size-9" strokeWidth={1.5} /> },
  booking: { name: 'Booking', icon: <CalendarCheck className="size-9" strokeWidth={1.5} /> },
};
const categoryOf = (t: PersonalityTemplate) => CATEGORY[t.id] ?? { name: 'General', icon: <ConciergeBell className="size-9" strokeWidth={1.5} /> };

/** Agent Templates: a gallery of ready-made agents. "Use template" creates one with its personality and goal filled in. */
export function Templates() {
  const kbs = useKnowledgeBases();
  const create = useCreateAgent();
  const { role } = useAuth();
  const canCreate = roleAtLeast(role, 'admin');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');

  const categories = ['All', ...new Set(PERSONALITY_TEMPLATES.map((t) => categoryOf(t).name))];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PERSONALITY_TEMPLATES.filter(
      (t) => (category === 'All' || categoryOf(t).name === category) && (!q || [t.label, t.description, t.goal, categoryOf(t).name].some((x) => x.toLowerCase().includes(q))),
    );
  }, [query, category]);
  const countIn = (name: string) => PERSONALITY_TEMPLATES.filter((t) => name === 'All' || categoryOf(t).name === name).length;

  return (
    <section className="mx-auto max-w-6xl px-4 py-7 sm:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-[28px] leading-9 font-medium text-fg">Agent Templates</h2>
          <p className="text-[16px] text-fg-2">Start with a ready-made agent. Its personality and goal are filled in, and you can change everything afterwards.</p>
        </div>
        <label className="flex h-10 w-full items-center gap-2 rounded-lg border border-border-strong bg-input-bg px-3 text-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)] sm:w-72">
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="sr-only">Search for agents</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for agents..." className="min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-faint focus:outline-none" />
        </label>
      </div>

      {create.error ? <ErrorBanner className="mb-4" error={create.error} title="We couldn't create the agent." /> : null}

      <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
        <aside aria-label="Filters">
          <h3 className="mb-2 text-body font-semibold text-fg">Categories</h3>
          <div role="radiogroup" aria-label="Category" className="flex flex-wrap gap-2 lg:flex-col lg:gap-0.5">
            {categories.map((name) => (
              <label
                key={name}
                className={cx(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-body-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
                  category === name ? 'bg-accent-soft font-semibold text-accent-text' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
                )}
              >
                <input type="radio" name="template-category" className="sr-only" checked={category === name} onChange={() => setCategory(name)} />
                <span className="flex-1">{name}</span>
                <span className="text-caption text-muted tabular-nums">{countIn(name)}</span>
              </label>
            ))}
          </div>
          <p className="mt-5 hidden border-t border-border pt-4 text-caption text-muted lg:block">All templates are free. Voice templates aren't available yet.</p>
        </aside>

        <div>
          {shown.length === 0 ? (
            <EmptyState
              icon={<Search className="size-5" />}
              title="No templates match"
              description={query ? `Nothing matches “${query}”.` : 'Nothing in this category.'}
              action={
                <Button
                  onClick={() => {
                    setQuery('');
                    setCategory('All');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((t) => {
                const cat = categoryOf(t);
                const busy = create.isPending && create.variables?.name.startsWith(t.label);
                return (
                  <li key={t.id} className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-card transition-shadow hover:shadow-raise">
                    <div className="relative flex h-36 items-center justify-between gap-3 overflow-hidden bg-ai-soft px-5">
                      <span className="max-w-[45%] text-body-sm leading-5 font-medium text-ai-text">{t.label}</span>
                      <span className="relative flex size-28 shrink-0 items-center justify-center" aria-hidden>
                        <span className="absolute inset-0 rounded-full border border-ai/25" />
                        <span className="absolute inset-3 rounded-full border border-ai/30" />
                        <span className="relative flex size-[76px] items-center justify-center rounded-full bg-surface text-ai-text shadow-card ring-4 ring-surface/70">{cat.icon}</span>
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-4">
                      <h3 className="text-[16px] leading-6 font-semibold text-fg">{t.label}</h3>
                      <p className="text-caption text-muted">By Omni AI</p>
                      <p className="mt-1 text-body-sm text-fg-2">{t.description}</p>
                      <p className="text-caption text-muted">Goal: {t.goal}</p>
                      <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                        <span className="flex flex-wrap gap-1.5">
                          <span className="rounded-md bg-surface-2 px-2 py-0.5 text-label font-medium text-fg-2">Free</span>
                          <span className="rounded-md bg-surface-2 px-2 py-0.5 text-label font-medium text-fg-2">{cat.name}</span>
                        </span>
                        {canCreate && (
                          <Button size="sm" variant="secondary" loading={busy} disabled={create.isPending} onClick={() => create.mutate(agentPreset(t, (kbs.data ?? []).map((k) => k.id)))}>
                            Use template
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
