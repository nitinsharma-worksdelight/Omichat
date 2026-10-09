import { CalendarCheck, CircleHelp, Plus, Store } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Modal } from '../../components/overlay';
import { Button, cx, ErrorBanner } from '../../components/ui';
import { post } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { useKnowledgeBases } from '../../lib/queries';
import { navigate } from '../../lib/router';
import type { Bot } from '../../lib/types';
import { PERSONALITY_TEMPLATES, type PersonalityTemplate } from '../bots/sections';
import { AGENT_KINDS, agentPreset, type AgentKind, type AgentPreset } from './shared';

const ART: Record<AgentKind, ReactNode> = {
  qa: <CircleHelp className="size-11" strokeWidth={1.5} aria-hidden />,
  booking: <CalendarCheck className="size-11" strokeWidth={1.5} aria-hidden />,
  market: <Store className="size-11" strokeWidth={1.5} aria-hidden />,
  scratch: <Plus className="size-11" strokeWidth={1.5} aria-hidden />,
};

/** Creates the agent with what was chosen and opens it in the editor. */
export function useCreateAgent(onDone?: () => void) {
  return useAction((preset: AgentPreset) => post<Bot>('/v1/bots', { name: preset.name, config: preset.config, knowledgeBaseIds: preset.knowledgeBaseIds }), {
    invalidate: [['bots']],
    success: 'Agent created',
    errorToast: false,
    onSuccess: (bot, preset) => {
      onDone?.();
      navigate(`/bots/${bot.id}${preset.setup ? `?setup=${preset.setup}` : ''}`);
    },
  });
}

/** GHL's "Create new agent": four starting points, then (for Marketplace Templates) the templates. */
export function CreateAgentModal({ open, onClose, initialTemplate }: { open: boolean; onClose: () => void; initialTemplate?: boolean }) {
  const [kind, setKind] = useState<AgentKind>('qa');
  const [step, setStep] = useState<'choose' | 'templates'>(initialTemplate ? 'templates' : 'choose');
  const kbs = useKnowledgeBases();
  const close = () => {
    onClose();
    setStep(initialTemplate ? 'templates' : 'choose');
    setKind('qa');
    create.reset();
  };
  const create = useCreateAgent(close);
  const allKbs = (kbs.data ?? []).map((kb) => kb.id);
  const start = (choice: Exclude<AgentKind, 'market'> | PersonalityTemplate) => create.mutate(agentPreset(choice, typeof choice === 'string' && choice !== 'qa' ? [] : allKbs));

  return (
    <Modal
      open={open}
      onClose={close}
      size="2xl"
      title={step === 'choose' ? 'Create new agent' : 'Marketplace Templates'}
      description={step === 'templates' ? 'Start with the prompt and personality filled in. You can change everything afterwards.' : undefined}
      footer={
        step === 'choose' ? (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => (kind === 'market' ? setStep('templates') : start(kind))}>
              Continue
            </Button>
          </>
        ) : (
          <div className="flex w-full justify-between">
            {initialTemplate ? <span /> : <Button onClick={() => setStep('choose')}>Back</Button>}
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
          </div>
        )
      }
    >
      {create.error ? <ErrorBanner className="mb-4" error={create.error} title="We couldn't create the agent." /> : null}
      {step === 'choose' ? (
        <div role="radiogroup" aria-label="Agent type" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {AGENT_KINDS.map((k) => {
            const checked = kind === k.id;
            return (
              <label
                key={k.id}
                className={cx(
                  'flex cursor-pointer flex-col rounded-xl bg-surface shadow-card transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                  checked ? 'border-2 border-accent' : 'border border-border hover:border-border-strong',
                )}
              >
                <span className="flex items-start justify-between gap-3 px-5 pt-5">
                  <span className="text-[16px] leading-6 font-medium text-fg">{k.title}</span>
                  <input type="radio" name="agent-kind" value={k.id} checked={checked} onChange={() => setKind(k.id)} className="mt-1 size-4.5 accent-accent" />
                </span>
                <span className="min-h-[120px] px-5 pt-1 pb-3 text-body-sm leading-5 text-fg-2">{k.description}</span>
                <span className="m-1.5 mt-auto flex h-40 items-center justify-center rounded-lg bg-surface-2">
                  <span
                    className={cx(
                      'flex size-20 items-center justify-center border border-border bg-surface',
                      k.id === 'scratch' ? 'rounded-full text-fg' : 'rounded-2xl text-accent',
                    )}
                  >
                    {ART[k.id]}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {PERSONALITY_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={create.isPending}
              onClick={() => start(t)}
              className="flex flex-col items-start gap-1 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-60"
            >
              <span className="text-body font-semibold text-fg">{t.label}</span>
              <span className="text-body-sm text-muted">{t.description}</span>
              <span className="mt-1 text-caption text-fg-2">Goal: {t.goal}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
