import { Plus, Trash2, UserRoundCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Modal } from '../../../components/overlay';
import { Button, ChipsInput, cx, Field, IconButton, Input, NumberInput, Select, Toggle } from '../../../components/ui';
import type { Handoff, HandoffScenario } from '../../../lib/types';
import type { EditorContext } from '../../bots/sections';

type Unit = 'minutes' | 'hours' | 'days';
const MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
/** The longest a chat can stay with the team before the assistant takes it back (the server's limit): 30 days. */
const MAX_MINUTES = 30 * 1440;
/** GHL allows six handover actions per bot; so does the server. */
const MAX_SCENARIOS = 6;

/** A scenario as edited: the take-back time as a number and a unit, and who gets the chat ('' = not chosen yet). */
interface Draft extends Omit<HandoffScenario, 'reactivate' | 'assignTo'> {
  reactivate: { enabled: boolean; amount: number; unit: Unit };
  assign: string;
}

/** 480 minutes reads as "8 hours", 4320 as "3 days", 90 as "90 minutes". */
function split(minutes: number): { amount: number; unit: Unit } {
  if (minutes % 60 === 0 && minutes / 60 <= 48) return { amount: minutes / 60, unit: 'hours' };
  if (minutes % 1440 === 0) return { amount: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { amount: minutes / 60, unit: 'hours' };
  return { amount: minutes, unit: 'minutes' };
}

const OWNER = 'owner';

/** No team member chosen = keep the contact's current assignee (GHL's "skip assignment"). */
const toDraft = (s: HandoffScenario): Draft => {
  const { reactivate, assignTo, ...rest } = structuredClone(s);
  return { ...rest, reactivate: { enabled: reactivate.enabled, ...split(reactivate.afterMinutes) }, assign: assignTo ?? OWNER };
};

/** GHL gives example phrases to Human Requested only (and to the business's own scenarios). */
const hasExamples = (d: Pick<Draft, 'preset'>) => d.preset === null || d.preset === 'human_requested';

function blankDraft(n: number): Draft {
  return {
    preset: null,
    enabled: false,
    name: `Scenario ${n}`,
    condition: '',
    examples: [''],
    assign: OWNER,
    finalMessage: '',
    reactivate: { enabled: true, amount: 8, unit: 'hours' },
    createTask: true,
    tags: [],
  };
}

type Problems = Partial<Record<'name' | 'condition' | 'finalMessage' | 'reactivate', string>>;

function problemsOf(d: Draft, all: Draft[]): Problems {
  const p: Problems = {};
  if (!d.name.trim()) p.name = 'Give the scenario a name.';
  else if (all.filter((o) => o.name.trim().toLowerCase() === d.name.trim().toLowerCase()).length > 1) p.name = 'Another scenario has this name.';
  if (!d.condition.trim()) p.condition = 'Say when the bot should hand over.';
  if (!d.finalMessage.trim()) p.finalMessage = 'Write what the customer is told.';
  if (d.reactivate.enabled) {
    if (!Number.isInteger(d.reactivate.amount) || d.reactivate.amount < 1) p.reactivate = 'Enter a whole number, 1 or more.';
    else if (d.reactivate.amount * MINUTES[d.reactivate.unit] > MAX_MINUTES) p.reactivate = 'At most 30 days.';
  }
  return p;
}

function Info({ text }: { text: string }) {
  return (
    <span className="text-muted" title={text}>
      ⓘ<span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * GHL's "Human Handover": scenarios that hand the chat to a person, each with its own team member, message, take-back
 * time, follow-up task and tags. Handover is on while a scenario is. Waiting for a reply, the away message and team
 * hours are under Timing & Pacing. Save puts it on the draft; nothing is stored until the agent is saved.
 */
export function HumanHandoverModal({ open, value, ctx, onApply, onClose }: { open: boolean; value: Handoff; ctx: EditorContext; onApply: (v: Handoff) => void; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [at, setAt] = useState(0);
  const [checked, setChecked] = useState(false);
  const [help, setHelp] = useState(false);

  // Each opening starts from what's on the agent (new agents come with GHL's three ready-made scenarios, off).
  useEffect(() => {
    if (!open) return;
    setDrafts(value.scenarios.map(toDraft));
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
  const anyOn = drafts.some((d) => d.enabled);

  const save = () => {
    const firstBad = problems.findIndex((p) => Object.keys(p).length > 0);
    if (firstBad !== -1) {
      setChecked(true);
      setAt(firstBad);
      return;
    }
    const scenarios: HandoffScenario[] = drafts.map(({ reactivate, assign, ...d }) => ({
      ...d,
      name: d.name.trim(),
      condition: d.condition.trim(),
      examples: hasExamples(d) ? d.examples.map((e) => e.trim()).filter(Boolean) : [],
      finalMessage: d.finalMessage.trim(),
      assignTo: assign && assign !== OWNER ? assign : null,
      reactivate: { enabled: reactivate.enabled, afterMinutes: reactivate.amount * MINUTES[reactivate.unit] },
    }));
    // As the server works them out: on while a scenario is; Human Requested's phrases are the instant triggers.
    const human = scenarios.find((x) => x.enabled && x.preset === 'human_requested');
    onApply({ ...value, scenarios, enabled: anyOn, keywords: human ? human.examples.filter((e) => e.length >= 2) : [] });
  };
  const remove = () => {
    setDrafts((list) => list.filter((_, i) => i !== at));
    setAt((i) => Math.max(0, i - 1));
  };
  const members = ctx.members;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-text">
            <UserRoundCog className="size-5" aria-hidden />
          </span>
          <span>
            Human Handover
            <span className="block text-body-sm font-normal text-fg-2">
              Assign conversation to a human when any enabled scenario occurs.{' '}
              <button type="button" aria-expanded={help} onClick={() => setHelp((h) => !h)} className="font-medium text-accent-text hover:underline">
                (Learn More)
              </button>
            </span>
          </span>
        </span>
      }
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            className="text-accent-text"
            icon={<Plus className="size-4" aria-hidden />}
            disabled={drafts.length >= MAX_SCENARIOS}
            onClick={() => {
              setDrafts((list) => [...list, blankDraft(list.length + 1)]);
              setAt(drafts.length);
            }}
          >
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
            When a scenario is <b>on</b> and the conversation matches its trigger condition, the bot sends the scenario's <b>final message</b>, gives the conversation to the chosen team
            member, creates a follow-up task (due in 24 hours), adds the tags, alerts the team and stops replying. With no scenario on, the bot doesn't hand chats over (an AI error or the
            monthly budget still does).
          </p>
          <p>
            <b>Human Requested</b>'s example phrases also hand over at once, without the AI, when a customer writes one. With <b>Reactivate bot after</b>, the bot takes the conversation back
            after that time, unless your team replied within it. Waiting for a reply, the away message and team hours are under <b>Timing &amp; Pacing</b>.
          </p>
        </div>
      )}
      <div className="grid h-[min(460px,58vh)] min-h-0 sm:grid-cols-[210px_1fr]">
        <ul aria-label="Scenarios" className="flex gap-1 overflow-x-auto border-b border-border pb-2 sm:block sm:space-y-0.5 sm:overflow-y-auto sm:border-r sm:border-b-0 sm:pb-0">
          {drafts.map((d, i) => (
            <li key={d.id ?? `new-${i}`}>
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
            <p className="py-8 text-center text-body-sm text-muted">No scenarios. Add one with New Scenario.</p>
          ) : (
            <>
              <Toggle label="Enable scenario" checked={current.enabled} onChange={(v) => set({ enabled: v })} className="items-center justify-start gap-3 [&>button]:order-1 [&>div]:order-2" />
              <Field label="Scenario name" required error={shown.name}>
                <Input value={current.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Trigger Condition" required error={shown.condition} hint="Define when the bot should handover the conversation to a human">
                <Input value={current.condition} maxLength={300} onChange={(e) => set({ condition: e.target.value })} />
              </Field>

              {hasExamples(current) && (
              <fieldset className="space-y-2 rounded-lg border border-border bg-surface-2/60 p-4">
                <legend className="sr-only">Example phrases</legend>
                <p className="text-body-sm font-medium text-fg">Example Phrases</p>
                <p className="text-caption text-muted">
                  Add example phrases that trigger this scenario.
                  {current.preset === 'human_requested' && ' A customer message that contains one hands over at once, without the AI.'}
                </p>
                {current.examples.map((phrase, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input aria-label={`Example phrase ${i + 1}`} value={phrase} maxLength={120} onChange={(e) => set({ examples: current.examples.map((p, j) => (j === i ? e.target.value : p)) })} />
                    <IconButton label={`Remove example phrase ${i + 1}`} size="sm" onClick={() => set({ examples: current.examples.filter((_, j) => j !== i) })}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} disabled={current.examples.length >= 30} onClick={() => set({ examples: [...current.examples, ''] })}>
                  Add Example Phrase
                </Button>
              </fieldset>
              )}

              <Field label="Assign Conversation to a Specific User" required>
                <Select value={current.assign} onChange={(e) => set({ assign: e.target.value })}>
                  <option value={OWNER}>Keep the contact's current assignee (else their owner)</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name || m.email}
                    </option>
                  ))}
                  {current.assign && current.assign !== OWNER && !members.some((m) => m.userId === current.assign) && <option value={current.assign}>A former team member: choose another</option>}
                </Select>
              </Field>

              <Field
                label={
                  <span>
                    Final Message <Info text="Sent exactly as written when the conversation is handed over." />
                  </span>
                }
                required
                error={shown.finalMessage}
                hint="This is the final message the bot will send before going to sleep"
              >
                <Input value={current.finalMessage} maxLength={500} onChange={(e) => set({ finalMessage: e.target.value })} />
              </Field>

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2.5 text-body text-fg">
                    <input type="checkbox" className="size-4 accent-accent" checked={current.reactivate.enabled} onChange={(e) => setReactivate({ enabled: e.target.checked })} />
                    Reactivate bot after <Info text="The bot takes the conversation back after this long, unless your team replied within it." />
                  </label>
                  <NumberInput aria-label="Reactivate after" className="w-28" min={1} step={1} disabled={!current.reactivate.enabled} value={current.reactivate.amount} onChange={(v) => setReactivate({ amount: v ?? 0 })} />
                  <Select aria-label="Unit" className="w-32" disabled={!current.reactivate.enabled} value={current.reactivate.unit} onChange={(e) => setReactivate({ unit: e.target.value as Unit })}>
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </Select>
                </div>
                {shown.reactivate && <p className="text-caption text-danger-text">{shown.reactivate}</p>}
                {!current.reactivate.enabled && <p className="text-caption text-muted">The conversation stays with the team until someone presses Resume AI.</p>}
              </div>

              <label className="flex items-center gap-2.5 text-body text-fg">
                <input type="checkbox" className="size-4 accent-accent" checked={current.createTask} onChange={(e) => set({ createTask: e.target.checked })} />
                Create a task on the contact <Info text="A follow-up task for whoever gets the conversation, linked to it." />
              </label>
              <p className="-mt-3 text-caption text-muted">
                New scenarios start with a task and a take-back after 8 hours. A scenario that was already handing chats over before these options existed starts with both off, so it keeps
                behaving as it did; change them here if you want.
              </p>

              <Field label="Add custom tags (optional)" hint="Add a tag to contact after human handover is completed">
                <ChipsInput value={current.tags} onChange={(tags) => set({ tags })} suggestions={ctx.tags.map((x) => x.name)} placeholder="Type a tag and press Enter" />
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
