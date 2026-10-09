import { ArrowRight, BookOpen, CalendarCheck, Check, MessageSquareText, PenLine, Plus, Rocket, Sparkles, UserRound, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Button, cx } from '../../components/ui';
import { roleAtLeast, useBots, useChannels, useKnowledgeBases } from '../../lib/queries';
import { Link, navigate } from '../../lib/router';
import { CreateAgentModal } from './CreateAgentModal';
import { agentChannels } from './shared';

interface Step {
  id: string;
  icon: ReactNode;
  title: string;
  summary: string;
  /** What to do, in order. */
  todo: ReactNode[];
  /** `null`: nothing records this step, so it never gets a tick. */
  done: boolean | null;
  optional?: boolean;
  actions: ReactNode;
}

function scrollToGuide() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('how-it-works')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/** Getting Started: what an AI agent does, then a step-by-step guide to creating one and putting it on your website. */
export function GettingStarted() {
  const { role } = useAuth();
  const canCreate = roleAtLeast(role, 'admin');
  const bots = useBots();
  const kbs = useKnowledgeBases();
  const channels = useChannels();
  const [creating, setCreating] = useState(false);

  const list = bots.data ?? [];
  // The steps open the agent worked on last.
  const latest = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const withDocuments = new Set((kbs.data ?? []).filter((k) => k.documentCount > 0).map((k) => k.id));
  const written = list.some((b) => b.config.instructions.trim());
  const hasKnowledge = list.some((b) => b.knowledgeBaseIds.some((id) => withDocuments.has(id)));
  const hasActions = list.some((b) => b.config.booking.enabled || b.config.actions.customApis.length > 0 || b.config.actions.workflowKeys.length > 0);
  const deployed = list.some((b) => b.isActive && agentChannels(channels.data, b.id).some((c) => c.status === 'active' && c.channel === 'webchat'));

  const editor = (label: string, to = '') =>
    latest ? (
      <Button onClick={() => navigate(`/bots/${latest.id}${to}`)}>{label}</Button>
    ) : (
      <span className="text-caption text-muted">Create an agent first</span>
    );

  const steps: Step[] = [
    {
      id: 'create',
      icon: <Plus className="size-4.5" />,
      title: 'Create your agent',
      summary: 'Pick a starting point. You can change everything afterwards.',
      todo: [
        <>
          Open <b>Conversation AI</b> and press <b>Create Agent</b>.
        </>,
        <>
          Choose <b>General Q&amp;A</b> (answers questions), <b>Appointment booking</b>, a <b>Marketplace template</b>, or <b>Start from Scratch</b>.
        </>,
        <>
          Press <b>Continue</b>. The agent is created at once and opens in the editor.
        </>,
      ],
      done: list.length > 0,
      actions: canCreate ? (
        <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
          Create Agent
        </Button>
      ) : (
        <span className="text-caption text-muted">Ask an admin to create agents.</span>
      ),
    },
    {
      id: 'prompt',
      icon: <PenLine className="size-4.5" />,
      title: 'Write its prompt',
      summary: 'Tell the agent who it is, who it talks to and what it should achieve.',
      todo: [
        <>
          On the <b>Build</b> tab, write in the big box on the left: its role, its goal in one sentence, and what it must never do.
        </>,
        <>
          Fill in <b>Business Name</b>, and use <b># Custom Values</b> to insert details like {'{business_hours}'} or {'{business_website}'}: they're filled in for you.
        </>,
        <>Keep prices, services and policies in the Knowledge Base, not in the prompt.</>,
      ],
      done: written,
      actions: editor('Open the editor'),
    },
    {
      id: 'knowledge',
      icon: <BookOpen className="size-4.5" />,
      title: 'Add knowledge',
      summary: 'What the agent looks up to answer questions correctly.',
      todo: [
        <>
          Go to the <b>Knowledge Base</b> tab, press <b>New knowledge base</b>, then add FAQs, a web page or a PDF.
        </>,
        <>
          Use <b>Test retrieval</b> there to see what the agent would find for a customer's question.
        </>,
        <>
          Back in the editor, open <b>Knowledge Base Triggers</b> and tick the knowledge base. Press <b>Save</b>.
        </>,
      ],
      done: hasKnowledge,
      actions: (
        <>
          <Button onClick={() => navigate('/knowledge')}>Open Knowledge Base</Button>
          {editor('Open the editor')}
        </>
      ),
    },
    {
      id: 'actions',
      icon: <Zap className="size-4.5" />,
      title: 'Add actions',
      summary: 'What the agent can do besides talk.',
      optional: true,
      todo: [
        <>
          In <b>Actions</b>, press <b>Setup Your Actions</b>.
        </>,
        <>
          <b>Appointment Booking</b> books on your calendar. <b>Contact Info</b> collects name and email. <b>Human Handover</b> passes the chat to your team.
        </>,
        <>
          <b>Trigger a Workflow</b> and <b>API Call</b> connect your own systems (CRM, orders, anything with an API). Turn on <b>Ask the team first</b> for anything that needs a
          person's OK.
        </>,
      ],
      done: hasActions,
      actions: editor('Open the editor'),
    },
    {
      id: 'test',
      icon: <MessageSquareText className="size-4.5" />,
      title: 'Test it',
      summary: 'Chat with it the way a customer would, before anyone else can.',
      todo: [
        <>
          Press <b>Save</b> first: the test chat uses the saved version.
        </>,
        <>
          Write to it in <b>Test your agent</b> on the right. Nothing there reaches your contacts.
        </>,
        <>
          Ask the real questions customers ask. Open <b>What the AI did</b> under the chat to see the actions it took. Change the prompt, save and try again.
        </>,
      ],
      done: null,
      actions: editor('Open the editor'),
    },
    {
      id: 'deploy',
      icon: <Rocket className="size-4.5" />,
      title: 'Deploy it to your website',
      summary: 'Put the agent on your website chat and switch it on.',
      todo: [
        <>
          Open the <b>Deploy</b> tab, and on <b>Chat widget</b> press <b>Configure</b>.
        </>,
        <>
          Tick your website chat (or create one). Press <b>Get the code</b> and paste it before &lt;/body&gt; on every page of your website.
        </>,
        <>
          Back on <b>Build</b>, open <b>Mode</b>, choose <b>Auto-Pilot</b> and press <b>Save</b>. The agent now replies to your visitors.
        </>,
      ],
      done: deployed,
      actions: editor('Open Deploy', '?tab=deploy'),
    },
  ];
  const finished = steps.filter((s) => s.done).length;
  const countable = steps.filter((s) => s.done !== null).length;

  return (
    <div>
      <section className="relative overflow-hidden border-b border-border bg-gradient-to-b from-accent-soft/60 to-bg">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:py-20">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-[11px] font-semibold tracking-[0.12em] text-accent-text uppercase">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              AI Agents
            </span>
            <h2 className="mt-5 font-display text-[40px] leading-[1.08] font-bold tracking-[-0.03em] text-fg sm:text-[48px]">
              Answer every customer, <span className="text-accent italic">instantly.</span>
            </h2>
            <p className="mt-5 max-w-xl text-[17px] leading-7 text-fg-2">
              Create an AI agent in minutes, teach it about your business and put it on your website chat. It answers questions from your knowledge, collects lead details, books
              appointments, and hands over to your team when a person is needed.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                size="md"
                className="h-11 px-6 text-[15px]"
                onClick={() => (canCreate ? setCreating(true) : navigate('/ai-agents/conversation-ai'))}
              >
                {canCreate ? 'Get Started' : 'See the agents'}
                <ArrowRight className="size-4" aria-hidden />
              </Button>
              <Button className="h-11 px-5 text-[15px]" onClick={scrollToGuide}>
                See how it works
              </Button>
              {!bots.isLoading && (
                <span className="text-body-sm text-muted">
                  {finished} of {countable} steps done
                </span>
              )}
            </div>
          </div>

          <div className="mx-auto w-full max-w-md" aria-hidden>
            <div className="relative mx-auto aspect-square w-full max-w-[380px]">
              <span className="absolute inset-0 rounded-full border border-dashed border-border-strong" />
              <span className="absolute inset-[14%] rounded-full border border-dashed border-border-strong" />
              <span className="absolute inset-[28%] rounded-full bg-accent-soft" />
              <span className="absolute inset-[34%] flex items-center justify-center rounded-full bg-gradient-to-br from-[#6172f3] to-[#9e77ed] text-white shadow-[0_18px_40px_-12px_rgb(97_114_243/0.7)]">
                <Sparkles className="size-10" />
              </span>
              <Chip className="top-[6%] left-[2%]" icon={<MessageSquareText className="size-3.5" />}>
                Question answered
              </Chip>
              <Chip className="top-[26%] right-[-2%]" icon={<UserRound className="size-3.5" />}>
                Lead saved
              </Chip>
              <Chip className="right-[6%] bottom-[8%]" icon={<CalendarCheck className="size-3.5" />}>
                Booking requested
              </Chip>
              <Chip className="bottom-[22%] left-[-4%]" icon={<BookOpen className="size-3.5" />}>
                From your knowledge
              </Chip>
            </div>
            <ul className="mt-6 grid grid-cols-3 gap-2 rounded-2xl border border-border bg-surface p-3 shadow-card">
              {(
                [
                  [<MessageSquareText key="a" className="size-4" />, 'Answers 24/7'],
                  [<CalendarCheck key="b" className="size-4" />, 'Books visits'],
                  [<UserRound key="c" className="size-4" />, 'Hands over to you'],
                ] as const
              ).map(([icon, label]) => (
                <li key={label} className="flex flex-col items-center gap-1.5 px-1 py-1 text-center text-caption font-medium text-fg-2">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent-text">{icon}</span>
                  {label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-4xl scroll-mt-20 px-4 py-14 sm:px-8">
        <div className="text-center">
          <h2 className="font-display text-[30px] leading-9 font-bold tracking-[-0.02em] text-fg">How to create and deploy an AI agent</h2>
          <p className="mx-auto mt-2 max-w-xl text-[16px] text-fg-2">Six steps from nothing to an agent answering customers on your website. Steps tick off as you finish them.</p>
        </div>

        <ol className="mt-10">
          {steps.map((step, i) => (
            <li key={step.id} className="relative flex gap-4 pb-8 last:pb-0 sm:gap-6">
              {i < steps.length - 1 && <span className="absolute top-11 bottom-0 left-[19px] w-px bg-border-strong" aria-hidden />}
              <span
                className={cx(
                  'relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border-2 font-semibold',
                  step.done ? 'border-success bg-success-soft text-success-text' : 'border-accent bg-surface text-accent-text',
                )}
              >
                {step.done ? <Check className="size-5" aria-label="Done" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface p-5 shadow-card">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent-text" aria-hidden>
                    {step.icon}
                  </span>
                  <h3 className="text-[18px] leading-6 font-semibold text-fg">{step.title}</h3>
                  {step.optional && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-label font-medium text-muted">Optional</span>}
                  {step.done && <span className="rounded-full bg-success-soft px-2 py-0.5 text-label font-semibold text-success-text">Done</span>}
                </div>
                <p className="mt-1.5 text-body text-fg-2">{step.summary}</p>
                <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-body-sm leading-5 text-fg-2 marker:font-semibold marker:text-muted">
                  {step.todo.map((t, n) => (
                    <li key={n}>{t}</li>
                  ))}
                </ol>
                <div className="mt-4 flex flex-wrap items-center gap-2">{step.actions}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-t border-border bg-surface-2/50">
        <div className="mx-auto max-w-4xl px-4 py-12 sm:px-8">
          <h2 className="font-display text-[24px] leading-8 font-bold tracking-[-0.01em] text-fg">Agent not replying on your website?</h2>
          <p className="mt-1 text-body text-fg-2">Check these, in order:</p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              ['Mode is Auto-Pilot, and saved', 'On the Build tab, Mode must be Auto-Pilot, and the Save button greyed out (nothing unsaved).'],
              ['A website chat is connected', 'Deploy → Chat widget → Configure: your website chat is ticked. The agents list shows it under Assigned channels.'],
              ['Your website is allowed', 'Settings → Channels: your website address is in the allowed websites, and the chat code is on the page.'],
              ['AI is not paused', 'A yellow "AI paused" label in the top bar means AI replies are switched off in Settings.'],
            ].map(([title, text]) => (
              <li key={title} className="rounded-xl border border-border bg-surface p-4">
                <p className="flex items-start gap-2 text-body-sm font-semibold text-fg">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {title}
                </p>
                <p className="mt-1 pl-6 text-body-sm text-fg-2">{text}</p>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-body-sm text-muted">
            Still stuck? Open a conversation in{' '}
            <Link to="/conversations" className="font-medium text-accent-text hover:underline">
              Conversations
            </Link>{' '}
            to see what the agent did, or look in Agent Logs for actions waiting for your approval.
          </p>
        </div>
      </section>

      <CreateAgentModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function Chip({ className, icon, children }: { className?: string; icon: ReactNode; children: ReactNode }) {
  return (
    <span className={cx('absolute flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-caption font-medium whitespace-nowrap text-fg shadow-raise', className)}>
      <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent-text">{icon}</span>
      {children}
    </span>
  );
}
