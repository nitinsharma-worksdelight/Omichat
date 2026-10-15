import { Hash, Redo2, Settings2, Undo2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { Modal, MenuItem, Popover } from '../../../components/overlay';
import { Button, cx, Field, Input, NumberInput, Select } from '../../../components/ui';
import { formatNumber } from '../../../lib/format';
import { acceptsEdit, countWords, MAX_INSTRUCTION_WORDS } from '../../../lib/words';
import { useAiConfig } from '../../../lib/queries';
import { EFFORTS, type Effort } from '../../../lib/types';
import type { BotDraft } from '../../bots/editorNav';


/** Models offered by name for the OpenAI provider; any other id can be typed under "Other model". */
const OPENAI_MODELS = [
  ['gpt-4.1', 'OpenAI GPT 4.1'],
  ['gpt-4.1-mini', 'OpenAI GPT 4.1 mini'],
  ['gpt-4o', 'OpenAI GPT 4o'],
  ['gpt-4o-mini', 'OpenAI GPT 4o mini'],
] as const;

/**
 * The "# Custom Values" menu, hidden on request (2026-10-15) but kept to switch back on. Prompts that already contain
 * `{business_name}` and the like are still filled in by the server.
 */
const SHOW_CUSTOM_VALUES = false;

/** What "# Custom Values" inserts; the server fills them in from the agent's settings when it builds the prompt. */
const CUSTOM_VALUES = [
  ['Business name', '{business_name}'],
  ['Agent name', '{agent_name}'],
  ['Opening hours', '{business_hours}'],
  ['Website', '{business_website}'],
  ['Phone', '{business_phone}'],
  ['Email', '{business_email}'],
  ['Location', '{business_location}'],
] as const;

/**
 * Undo and redo for the prompt, a word at a time: typing letters extends the current step, anything else (a space,
 * a paste, a deletion, an inserted value) starts a new one.
 */
function usePromptHistory(value: string, onChange: (v: string) => void) {
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const grouping = useRef(false);
  const [, rerender] = useState(0);
  const change = (next: string, typed: boolean) => {
    if (!(typed && grouping.current)) past.current = [...past.current.slice(-199), value];
    future.current = [];
    grouping.current = typed;
    onChange(next);
    rerender((n) => n + 1);
  };
  const step = (from: MutableRefObject<string[]>, to: MutableRefObject<string[]>) => {
    const prev = from.current.at(-1);
    if (prev === undefined) return;
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, value];
    grouping.current = false;
    onChange(prev);
    rerender((n) => n + 1);
  };
  return {
    change,
    undo: () => step(past, future),
    redo: () => step(future, past),
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}

export function PromptPanel({ draft, setDraft, readOnly }: { draft: BotDraft; setDraft: (d: BotDraft) => void; readOnly: boolean }) {
  const ai = useAiConfig().data;
  const area = useRef<HTMLTextAreaElement>(null);
  /** Where the cursor goes once an inserted value is on screen. */
  const caretAfterInsert = useRef<number | null>(null);
  const [guidelines, setGuidelines] = useState(false);
  const prompt = draft.config.instructions;
  const setPrompt = (next: string) => setDraft({ ...draft, config: { ...draft.config, instructions: next } });
  const history = usePromptHistory(prompt, setPrompt);
  const persona = draft.config.persona;

  const known = ai?.provider === 'openai' ? OPENAI_MODELS.map(([id]) => id as string) : [];
  const [otherModel, setOtherModel] = useState(() => Boolean(draft.model) && !known.includes(draft.model));
  const modelChoice = otherModel ? '__other' : draft.model;
  const tokens = Math.ceil(prompt.length / 4);
  const words = countWords(prompt);
  const over = words > MAX_INSTRUCTION_WORDS;
  // Shown when a keystroke or paste would have gone past the limit and was not taken.
  const [refused, setRefused] = useState(false);

  const insert = (token: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const next = `${prompt.slice(0, start)}${token}${prompt.slice(end)}`;
    // A Custom Value is a word: past the limit it isn't added.
    if (!acceptsEdit(prompt, next)) {
      setRefused(true);
      return;
    }
    setRefused(false);
    caretAfterInsert.current = start + token.length;
    history.change(next, false);
  };
  // Back in the editor, just after what was inserted, as soon as it's rendered.
  useLayoutEffect(() => {
    const at = caretAfterInsert.current;
    if (at === null) return;
    caretAfterInsert.current = null;
    area.current?.focus();
    area.current?.setSelectionRange(at, at);
  }, [prompt]);

  return (
    <section aria-label="Prompt" className="flex min-h-0 flex-1 flex-col bg-surface lg:rounded-tr-lg">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-2">
        <label className="flex items-center gap-2 text-caption font-semibold text-fg">
          Model
          <Select
            className="h-8 w-60 max-w-full text-body-sm font-normal"
            value={modelChoice}
            disabled={readOnly}
            onChange={(e) => {
              if (e.target.value === '__other') return setOtherModel(true);
              setOtherModel(false);
              setDraft({ ...draft, model: e.target.value });
            }}
          >
            <option value="">Default ({ai ? `${ai.provider} ${ai.model}` : 'server model'})</option>
            {ai?.provider === 'openai' &&
              OPENAI_MODELS.filter(([id]) => id !== ai.model).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            <option value="__other">Other model…</option>
          </Select>
        </label>
        {otherModel && (
          <Input
            aria-label="Model id"
            className="h-8 w-48 font-mono text-caption"
            placeholder="model id"
            value={draft.model}
            disabled={readOnly}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
        )}
        <Popover
          align="left"
          label="Model settings"
          className="w-72 p-3!"
          trigger={({ open, toggle, id }) => (
            <button
              type="button"
              aria-label="Model settings"
              title="Model settings"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? id : undefined}
              onClick={toggle}
              className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-2 hover:text-fg"
            >
              <Settings2 className="size-4" aria-hidden />
            </button>
          )}
        >
          {() => (
            <div className="space-y-3">
              <Field label="Reasoning effort" hint="Only reasoning models use this.">
                <Select value={draft.effort} disabled={readOnly} onChange={(e) => setDraft({ ...draft, effort: e.target.value as Effort | '' })}>
                  <option value="">Server default ({ai?.reasoningEffort ?? 'not set'})</option>
                  {EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Longest reply (tokens)" hint="1,024–64,000." error={draft.maxOutputTokens < 1024 || draft.maxOutputTokens > 64000 ? 'Between 1,024 and 64,000.' : null}>
                <NumberInput min={1024} max={64000} step={256} value={draft.maxOutputTokens} onChange={(v) => setDraft({ ...draft, maxOutputTokens: Math.round(v ?? 0) })} />
              </Field>
            </div>
          )}
        </Popover>
        <label className="flex items-center gap-2 text-caption font-semibold text-fg">
          Business Name
          <Input
            className="h-8 w-52 text-body-sm font-normal"
            placeholder="Your business name"
            maxLength={120}
            value={persona.companyName}
            disabled={readOnly}
            onChange={(e) => setDraft({ ...draft, config: { ...draft.config, persona: { ...persona, companyName: e.target.value } } })}
          />
        </label>
        <span className="flex-1" />
        <span className="text-caption text-fg-2" title="An estimate of how much of the prompt this text adds; the rest comes from the agent's other settings.">
          {formatNumber(tokens)} - {formatNumber(tokens + 1000)} tokens approx. ⓘ
        </span>
        <span aria-hidden className="text-border-strong">
          |
        </span>
        <span className={cx('text-caption tabular-nums', over ? 'font-semibold text-danger-text' : 'text-fg-2')}>
          {formatNumber(words)} / {formatNumber(MAX_INSTRUCTION_WORDS)} words
        </span>
      </div>

      <div className="mx-5 mt-5 mb-3 flex min-h-[420px] flex-1 flex-col rounded-md border border-border-strong focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1">
          <button type="button" aria-label="Undo" title="Undo" disabled={!history.canUndo || readOnly} onClick={history.undo} className="flex size-7 items-center justify-center rounded text-fg-2 hover:bg-surface-2 disabled:text-faint">
            <Undo2 className="size-4" aria-hidden />
          </button>
          <button type="button" aria-label="Redo" title="Redo" disabled={!history.canRedo || readOnly} onClick={history.redo} className="flex size-7 items-center justify-center rounded text-fg-2 hover:bg-surface-2 disabled:text-faint">
            <Redo2 className="size-4" aria-hidden />
          </button>
          <span className="flex-1" />
          {SHOW_CUSTOM_VALUES && (
            <Popover
              label="Custom values"
              className="w-64"
              trigger={({ open, toggle, id }) => (
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-controls={open ? id : undefined}
                  disabled={readOnly}
                  onClick={toggle}
                  className="flex h-7 items-center gap-1 rounded border border-border bg-surface-2 px-2 text-caption font-medium text-fg hover:border-border-strong disabled:opacity-50"
                >
                  <Hash className="size-3.5" aria-hidden />
                  Custom Values
                </button>
              )}
            >
              {(close) => (
                <>
                  <p className="px-2.5 pt-1 pb-1.5 text-caption text-muted">Filled in from the agent's settings when it replies.</p>
                  {CUSTOM_VALUES.map(([label, token]) => (
                    <MenuItem
                      key={token}
                      onClick={() => {
                        close();
                        insert(token);
                      }}
                    >
                      <span className="flex-1">{label}</span>
                      <code className="font-mono text-label text-muted">{token}</code>
                    </MenuItem>
                  ))}
                </>
              )}
            </Popover>
          )}
        </div>
        <label htmlFor="agent-prompt" className="sr-only">
          Prompt
        </label>
        <textarea
          id="agent-prompt"
          ref={area}
          value={prompt}
          readOnly={readOnly}
          aria-invalid={over || undefined}
          onChange={(e) => {
            const next = e.target.value;
            // Past the word limit: the text stays as it was (deleting, spaces and line breaks are always fine).
            if (!acceptsEdit(prompt, next)) {
              setRefused(true);
              return;
            }
            setRefused(false);
            const caret = e.target.selectionStart;
            const typed = next.length === prompt.length + 1 && !/\s/.test(next.charAt(caret - 1));
            history.change(next, typed);
          }}
          placeholder="Personality"
          className="min-h-0 flex-1 resize-none bg-transparent p-3 text-[15px] leading-[22px] text-fg outline-none placeholder:text-faint"
        />
      </div>
      {(over || refused || words >= MAX_INSTRUCTION_WORDS) && (
        <p role="alert" className="mx-5 mb-2 text-caption text-danger-text">
          {over
            ? `The instructions are ${formatNumber(words)} words. The limit is ${formatNumber(MAX_INSTRUCTION_WORDS)} words: shorten them before saving.`
            : `You've reached the ${formatNumber(MAX_INSTRUCTION_WORDS)}-word limit${refused ? ', so that text was not added' : ''}. Remove some words to add more.`}
        </p>
      )}
      <p className="mx-5 mb-5 text-body text-fg-2">
        A good prompt will allow the bot to better interpret and respond appropriately.{' '}
        <button type="button" onClick={() => setGuidelines(true)} className="font-medium text-accent-text hover:underline">
          Prompt Guidelines ↗
        </button>
      </p>
      <Modal
        open={guidelines}
        onClose={() => setGuidelines(false)}
        size="lg"
        title="Prompt guidelines"
        footer={
          <Button variant="primary" onClick={() => setGuidelines(false)}>
            Got it
          </Button>
        }
      >
        <ul className="list-disc space-y-2 pl-5 text-body text-fg-2">
          <li>Say who the agent is and who it talks to: "You are the front desk of {persona.companyName || 'our clinic'}, chatting with new patients."</li>
          <li>Give the goal in one sentence, then the steps: what to find out, in what order, and what to do once it knows.</li>
          <li>Put facts (prices, services, policies) in the Knowledge Base, not here. The agent searches it and quotes it exactly.</li>
          {SHOW_CUSTOM_VALUES && <li>Use Custom Values for details that change, such as {'{business_hours}'}: they're filled in from the agent's settings.</li>}
          <li>Say what not to do: topics to avoid, promises it mustn't make, when to hand over to a person.</li>
          <li>Keep it short and plain. Test it in the panel on the right, then adjust.</li>
        </ul>
      </Modal>
    </section>
  );
}
