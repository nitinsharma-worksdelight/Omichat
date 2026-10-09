import type { z } from 'zod';
import type { ChannelType, WorkflowInputField } from '../../db/schema';
import type { BotView } from '../bots/service';
import type { CustomApi, ToolKey } from '../bots/config';

/** Everything a tool may act on. Identity fields come from the server, never from model output. */
export interface ToolContext {
  orgId: string;
  conversationId: string;
  /** Current contact; may change mid-run when captured details merge this visitor into an existing contact. */
  contactId: string;
  aiRunId: string;
  bot: BotView;
  channel: ChannelType;
  orgTimezone: string;
  now: Date;
  setContactId(id: string): void;
  requestHandoff(reason: string): void;
  /** `internal`: bookkeeping the customer doesn't need to see (staff still do). */
  activity(label: string, opts?: { internal?: boolean }): Promise<void>;
  /** Posts a message of the server's own right after the model's reply (e.g. a consent question, verbatim). */
  postAfterReply(message: { content: string; metadata?: Record<string, unknown> }): void;
  /** What this turn's tool schemas were built from (owner names, the deal pipeline), so a call maps back exactly. */
  schema: ToolSchemaContext;
  /** Set when the team approved this call (it asked first): who approved it. */
  approval?: { id: string; decidedByUserId: string };
}

/** Facts a tool needs to build its schema for this bot (enums of question keys, custom fields…). */
export interface ToolSchemaContext {
  bot: BotView;
  customFields: Array<{ key: string; label: string; type: string; options: string[]; description: string; aiWritable: boolean }>;
  workflows: Array<{ key: string; name: string; description: string; inputFields: WorkflowInputField[]; askFirst: boolean }>;
  allowedTags: string[];
  /** Stages the bot may set that are still among the organization's lifecycle stages. */
  lifecycleStages: string[];
  /** Team members the bot may make a contact's owner, with the unique names the model sees (never emails). */
  owners: Array<{ id: string; name: string }>;
  /** The pipeline the deal actions work in; null when they're off. */
  pipeline: { id: string; name: string; stages: Array<{ id: string; name: string }> } | null;
}

/** The custom APIs the assistant may call (switched on, in the bot's order). */
export function enabledApis(ctx: Pick<ToolSchemaContext, 'bot'>): CustomApi[] {
  return ctx.bot.config.actions.customApis.filter((a) => a.enabled);
}

/** Whether a call waits for the team: the bot's ask-first actions, or a workflow or API set to ask first. */
export function asksFirst(ctx: ToolSchemaContext, toolName: string, input: unknown): boolean {
  if (toolName === 'trigger_workflow') {
    const key = (input as { workflow_key?: unknown } | null)?.workflow_key;
    return ctx.workflows.some((w) => w.key === key && w.askFirst);
  }
  if (toolName === 'call_api') {
    const key = (input as { api?: unknown } | null)?.api;
    return enabledApis(ctx).some((a) => a.key === key && a.askFirst);
  }
  return (ctx.bot.config.actions.askFirst as readonly string[]).includes(toolName);
}

/** Whether any of these tools can wait for the team, so the prompt explains it (bots without keep the same prompt). */
export function hasAskFirst(ctx: ToolSchemaContext, activeTools: string[]): boolean {
  return (
    activeTools.some((t) => (ctx.bot.config.actions.askFirst as readonly string[]).includes(t)) ||
    (activeTools.includes('trigger_workflow') && ctx.workflows.some((w) => w.askFirst)) ||
    (activeTools.includes('call_api') && enabledApis(ctx).some((a) => a.askFirst))
  );
}

/** Unique, email-free names for the members a bot may assign, in the bot's order ("Maya", "Maya (2)"). */
export function ownerChoices(members: Array<{ userId: string; name: string; email: string }>, allowed: string[]): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const id of allowed) {
    const m = members.find((x) => x.userId === id);
    if (!m || out.some((o) => o.id === id)) continue;
    const base = m.name.trim() || m.email.split('@')[0]!;
    let name = base;
    for (let n = 2; out.some((o) => o.name === name); n++) name = `${base} (${n})`;
    out.push({ id, name });
  }
  return out;
}

export type ToolOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; data?: Record<string, unknown> };

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  key: ToolKey;
  /** Shown to the model: say *when* to call it, not just what it does. */
  description(ctx: ToolSchemaContext): string;
  schema(ctx: ToolSchemaContext): S;
  enabled(ctx: ToolSchemaContext): boolean;
  /** Short progress label streamed to the widget while the tool runs. */
  activity?: string;
  /** The label is record-keeping (saving details, noting answers): shown to staff, not to the customer. */
  activityInternal?: boolean;
  /**
   * Set on tools whose effect must not happen twice (a note, a task, an alert, a workflow call). When a turn is
   * retried, the Nth such call replays the Nth earlier result instead of running again; calls are matched by this
   * key (e.g. the workflow) and their order, not their wording, which a retried model rarely repeats exactly.
   */
  repeatKey?(input: z.infer<S>): string;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}

export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}
