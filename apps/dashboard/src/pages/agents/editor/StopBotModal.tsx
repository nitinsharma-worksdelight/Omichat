import { Ban, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Modal } from '../../../components/overlay';
import { Button, ChipsInput, cx, EmptyState, Field, IconButton, Input, NumberInput, Select, Toggle } from '../../../components/ui';
import type { StopScenario } from '../../../lib/types';

type Unit = 'minutes' | 'hours' | 'days';
const MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
/** The longest a stopped assistant can sleep (the server's limit): 30 days. */
const MAX_MINUTES = 30 * 1440;

/** A scenario as edited: the restart time as a number and a unit, which are minutes again on Save. */
interface Draft extends Omit<StopScenario, 'reactivate'> {
  reactivate: { enabled: boolean; amount: number; unit: Unit };
}

/** 1440 minutes reads as "24 hours" (as in GHL), 4320 as "3 days", 90 as "90 minutes". */
function split(minutes: number): { amount: number; unit: Unit } {
  if (minutes % 60 === 0 && minutes / 60 <= 48) return { amount: minutes / 60, unit: 'hours' };
  if (minutes % 1440 === 0) return { amount: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { amount: minutes / 60, unit: 'hours' };
  return { amount: minutes, unit: 'minutes' };
}

const toDraft = (s: StopScenario): Draft => ({ ...structuredClone(s), reactivate: { enabled: s.reactivate.enabled, ...split(s.reactivate.afterMinutes) } });

/** What a first scenario starts with, until the business changes it. */
export const DEFAULT_STOP_SCENARIO: StopScenario = {
  enabled: false,
  name: 'Goodbye Detection',
  condition: 'When the contact says goodbye or similar phrases',
  examples: ['Bye', 'Goodbye', 'Thank you! have a nice day'],
  finalMessage: 'Thank you for your time, Have a nice day.',
  reactivate: { enabled: true, afterMinutes: 1440 },
  tags: ['stop bot'],
};

function blankDraft(n: number): Draft {
  return {
    enabled: false,
    name: `Scenario ${n}`,
    condition: '',
    examples: [''],
    finalMessage: '',
    reactivate: { enabled: true, amount: 24, unit: 'hours' },
    tags: [],
  };
}

type Problems = Partial<Record<'name' | 'condition' | 'reactivate', string>>;

function problemsOf(d: Draft, all: Draft[]): Problems {
  const p: Problems = {};
  if (!d.name.trim()) p.name = 'Give the scenario a name.';
  else if (all.filter((o) => o.name.trim().toLowerCase() === d.name.trim().toLowerCase()).length > 1) p.name = 'Another scenario has this name.';
  if (!d.condition.trim()) p.condition = 'Say when the bot should stop.';
  if (d.reactivate.enabled) {
    const minutes = d.reactivate.amount * MINUTES[d.reactivate.unit];
    if (!Number.isInteger(d.reactivate.amount) || d.reactivate.amount < 1) p.reactivate = 'Enter a whole number, 1 or more.';
    else if (minutes > MAX_MINUTES) p.reactivate = 'At most 30 days.';
  }
  return p;
}

/**
 * GHL's "Stop Bot": scenarios in which the agent stops replying to a contact. Each has a trigger condition and example
 * phrases (the agent decides from them), a final message, an optional restart time and tags for the contact. Save puts
 * them on the draft; nothing is stored until the agent is saved.
 */
export function StopBotModal({ open, scenarios, tagSuggestions, onApply, onClose }: { open: boolean; scenarios: StopScenario[]; tagSuggestions: string[]; onApply: (s: StopScenario[]) => void; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [at, setAt] = useState(0);
  const [checked, setChecked] = useState(false);
  const [help, setHelp] = useState(false);

  // Each opening starts from what's on the agent; with nothing yet, from the Goodbye Detection example.
  useEffect(() => {
    if (!open) return;
    setDrafts((scenarios.length ? scenarios : [DEFAULT_STOP_SCENARIO]).map(toDraft));
    setAt(0);
    setChecked(false);
    setHelp(false);
    // Only when it opens: the agent changing underneath doesn't reset what's being edited.
  }, [open]);

  const current = drafts[at] as Draft | undefined;
  const set = (patch: Partial<Draft>) => setDrafts((list) => list.map((d, i) => (i === at ? { ...d, ...patch } : d)));
  const setReactivate = (patch: Partial<Draft['reactivate']>) => current && set({ reactivate: { ...current.reactivate, ...patch } });
  const problems = drafts.map((d) => problemsOf(d, drafts));
  const shown = checked && current ? problems[at]! : ({} as Problems);

  const save = () => {
    const firstBad = problems.findIndex((p) => Object.keys(p).length > 0);
    if (firstBad !== -1) {
      setChecked(true);
      setAt(firstBad);
      return;
    }
    onApply(
      drafts.map(({ reactivate, ...d }) => ({
        ...d,
        name: d.name.trim(),
        condition: d.condition.trim(),
        examples: d.examples.map((e) => e.trim()).filter(Boolean),
        finalMessage: d.finalMessage.trim(),
        reactivate: { enabled: reactivate.enabled, afterMinutes: reactivate.enabled ? reactivate.amount * MINUTES[reactivate.unit] : (scenarios.find((s) => s.id === d.id)?.reactivate.afterMinutes ?? 1440) },
      })),
    );
  };
  const remove = () => {
    setDrafts((list) => list.filter((_, i) => i !== at));
    setAt((i) => Math.max(0, i - 1));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-text">
            <Ban className="size-5" aria-hidden />
          </span>
          <span>
            Stop Bot
            <span className="block text-body-sm font-normal text-fg-2">
              Stops responding to the Contact when the Scenarios occur.{' '}
              <button type="button" aria-expanded={help} onClick={() => setHelp((h) => !h)} className="font-medium text-accent-text hover:underline">
                (Learn More)
              </button>
            </span>
          </span>
        </span>
      }
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button variant="ghost" className="text-accent-text" icon={<Plus className="size-4" aria-hidden />} disabled={drafts.length >= 10} onClick={() => {
            setDrafts((list) => [...list, blankDraft(list.length + 1)]);
            setAt(drafts.length);
          }}>
            New Scenario
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      }
    >
      {help && (
        <div role="note" className="mb-4 space-y-1.5 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-body-sm text-fg">
          <p>
            When a scenario is <b>on</b> and the conversation matches its trigger condition (or sounds like its example phrases), the bot sends the <b>final message</b>, adds the tags to the contact and
            stops replying.
          </p>
          <p>
            The conversation stays with the AI (the team isn't alerted). The bot starts again after the time you set, or when someone on the team presses <b>Resume AI</b> on the conversation. Messages the
            contact sends while the bot is stopped are not answered later.
          </p>
        </div>
      )}
      <div className="grid h-[min(440px,58vh)] min-h-0 gap-0 sm:grid-cols-[200px_1fr]">
        <ul aria-label="Scenarios" className="flex gap-1 overflow-x-auto border-b border-border pb-2 sm:block sm:space-y-0.5 sm:overflow-y-auto sm:border-r sm:border-b-0 sm:pr-0 sm:pb-0">
          {drafts.map((d, i) => (
            <li key={d.id ?? i}>
              <button
                type="button"
                aria-current={i === at ? 'true' : undefined}
                onClick={() => setAt(i)}
                className={cx(
                  'flex w-full items-center gap-2 border-b-2 px-3 py-2.5 text-left text-body-sm whitespace-nowrap sm:border-b-0 sm:border-l-2',
                  i === at ? 'border-accent text-accent-text' : 'border-transparent text-fg-2 hover:bg-surface-2',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{d.name || 'Untitled'}</span>
                {checked && Object.keys(problems[i]!).length > 0 && <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-label="has a problem" />}
                <span className="shrink-0 rounded-full border border-border-strong px-2 py-px text-label text-fg-2">{d.enabled ? 'On' : 'Off'}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-h-0 space-y-4 overflow-y-auto pt-4 sm:pt-0 sm:pl-4">
          {!current ? (
            <EmptyState title="No scenarios" description="Add one to tell the bot when to stop replying." />
          ) : (
            <>
              <Toggle label="Enable scenario" checked={current.enabled} onChange={(v) => set({ enabled: v })} className="items-center justify-start gap-3 [&>div]:order-2 [&>button]:order-1" />
              <Field label="Scenario name" required error={shown.name}>
                <Input value={current.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field
                label={
                  <span>
                    Trigger Condition <span className="text-muted" title="The bot reads this to decide when the conversation has reached this scenario.">ⓘ</span>
                  </span>
                }
                error={shown.condition}
                hint="Clearly define the scenario and situation when you want the bot to stop"
              >
                <Input value={current.condition} maxLength={300} onChange={(e) => set({ condition: e.target.value })} />
              </Field>

              <fieldset className="space-y-2 rounded-lg border border-border bg-surface-2/60 p-4">
                <legend className="sr-only">Example phrases</legend>
                <p className="text-body-sm font-medium text-fg">Example Phrases</p>
                <p className="text-caption text-muted">Add example phrases that trigger this scenario.</p>
                {current.examples.map((phrase, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input aria-label={`Example phrase ${i + 1}`} value={phrase} maxLength={120} onChange={(e) => set({ examples: current.examples.map((p, j) => (j === i ? e.target.value : p)) })} />
                    <IconButton label={`Remove example phrase ${i + 1}`} size="sm" onClick={() => set({ examples: current.examples.filter((_, j) => j !== i) })}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} disabled={current.examples.length >= 10} onClick={() => set({ examples: [...current.examples, ''] })}>
                  Add Example Phrase
                </Button>
              </fieldset>

              <Field
                label={
                  <span>
                    Final Message <span className="text-muted" title="Sent exactly as written. Leave it empty and the bot just goes quiet.">ⓘ</span>
                  </span>
                }
                hint="This is the final message the bot will send before going to sleep"
              >
                <Input value={current.finalMessage} maxLength={500} onChange={(e) => set({ finalMessage: e.target.value })} />
              </Field>

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2.5 text-body text-fg">
                    <input type="checkbox" className="size-4 accent-accent" checked={current.reactivate.enabled} onChange={(e) => setReactivate({ enabled: e.target.checked })} />
                    Reactivate bot after{' '}
                    <span className="text-muted" title="Off: the bot stays stopped until someone on the team presses Resume AI on the conversation.">
                      ⓘ
                    </span>
                  </label>
                  <NumberInput
                    aria-label="Reactivate after"
                    className="w-28"
                    min={1}
                    step={1}
                    disabled={!current.reactivate.enabled}
                    value={current.reactivate.amount}
                    onChange={(v) => setReactivate({ amount: v ?? 0 })}
                  />
                  <Select aria-label="Unit" className="w-32" disabled={!current.reactivate.enabled} value={current.reactivate.unit} onChange={(e) => setReactivate({ unit: e.target.value as Unit })}>
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </Select>
                </div>
                {shown.reactivate && <p className="text-caption text-danger-text">{shown.reactivate}</p>}
                {!current.reactivate.enabled && <p className="text-caption text-muted">The bot stays stopped until the team presses Resume AI on the conversation.</p>}
              </div>

              <Field
                label={
                  <span>
                    Add custom tags (optional) <span className="text-muted" title="Added to the contact when the bot stops. Created if they don't exist yet.">ⓘ</span>
                  </span>
                }
                hint="Add a tag to contact after bot is stopped"
              >
                <ChipsInput value={current.tags} onChange={(tags) => set({ tags })} suggestions={tagSuggestions} placeholder="Type a tag and press Enter" />
              </Field>

              <div className="border-t border-border pt-3">
                <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={remove}>
                  Delete scenario
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
