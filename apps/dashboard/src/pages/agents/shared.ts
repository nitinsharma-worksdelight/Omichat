import type { BotConfig, Channel, ChannelType } from '../../lib/types';
import { PERSONALITY_TEMPLATES, type PersonalityTemplate } from '../bots/sections';

/**
 * The AI Agents tabs, in GHL's order. Knowledge Base and Agent Logs keep their older addresses working. `hidden` tabs
 * are kept but not shown (hidden on request, 2026-10-10); their addresses open Conversation AI.
 */
export const AGENT_TABS = [
  { id: 'getting-started', label: 'Getting Started', to: '/ai-agents/getting-started', hidden: false },
  { id: 'agent-studio', label: 'Agent Studio', to: '/ai-agents/agent-studio', hidden: true },
  { id: 'voice-ai', label: 'Voice AI', to: '/ai-agents/voice-ai', hidden: true },
  { id: 'conversation-ai', label: 'Conversation AI', to: '/ai-agents/conversation-ai', hidden: false },
  { id: 'knowledge-base', label: 'Knowledge Base', to: '/knowledge', hidden: false },
  { id: 'templates', label: 'Agent Templates', to: '/ai-agents/templates', hidden: false },
  { id: 'content-ai', label: 'Content AI', to: '/ai-agents/content-ai', hidden: true },
  { id: 'logs', label: 'Agent Logs', to: '/ai-agents/logs', hidden: false },
] as const;
export type AgentTab = (typeof AGENT_TABS)[number]['id'];

/** A tab that's shown (a hidden one's address isn't a tab). */
export function isAgentTab(value: string | undefined): value is AgentTab {
  return AGENT_TABS.some((t) => t.id === value && !t.hidden);
}

/** A tab that exists but is hidden: its address goes to Conversation AI. */
export function isHiddenAgentTab(value: string | undefined): boolean {
  return AGENT_TABS.some((t) => t.id === value && t.hidden);
}

/** Where an agent is live: its channels, Test chat aside. */
export function agentChannels(channels: Channel[] | undefined, botId: string): Channel[] {
  return (channels ?? []).filter((c) => c.botId === botId && c.channel !== 'playground');
}

const CHANNEL_NAMES: Record<ChannelType, string> = { webchat: 'Chat widget', api: 'Chat API', playground: 'Test chat' };
export const channelKindName = (type: ChannelType) => CHANNEL_NAMES[type] ?? type;

/** "Chat widget (Main website)", or "Not assigned". */
export function channelsSummary(channels: Channel[]): string {
  const live = channels.filter((c) => c.status === 'active');
  if (!live.length) return 'Not assigned';
  return live.map((c) => (c.channel === 'webchat' ? `${channelKindName(c.channel)} (${c.name})` : channelKindName(c.channel))).join(', ');
}

/** GHL names a new agent by when it was made: "New Agent Oct 10, 12:05 AM". */
export function newAgentName(now = new Date()): string {
  return `New Agent ${now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

/** The first choice when creating an agent. */
export type AgentKind = 'qa' | 'booking' | 'market' | 'scratch';

export const AGENT_KINDS: Array<{ id: AgentKind; title: string; description: string }> = [
  {
    id: 'qa',
    title: 'General Q&A',
    description:
      'Simplify customer interactions by answering common questions instantly. This agent is perfect for handling FAQs, providing quick resolutions, and improving customer satisfaction.',
  },
  {
    id: 'booking',
    title: 'Appointment booking',
    description:
      'This agent helps streamline the appointment booking process by assisting users in selecting available slots and confirming appointments. Perfect for businesses with a high volume of scheduling needs.',
  },
  { id: 'market', title: 'Marketplace Templates', description: 'Discover pre-built agent templates. Get your AI agents up and running in minutes.' },
  {
    id: 'scratch',
    title: 'Start from Scratch',
    description: 'Create a custom agent tailored to your specific needs. Build from the ground up, defining its personality, intent, and actions to suit your unique requirements.',
  },
];

/** What a new agent is created with, and what the editor opens on first. */
export interface AgentPreset {
  name: string;
  /** Sections sent on create; fields left out get the server's defaults. */
  config: { persona?: Partial<BotConfig['persona']>; goals?: Partial<BotConfig['goals']>; instructions?: string };
  knowledgeBaseIds: string[];
  /** `kb` opens the Knowledge Base panel; `booking` opens the Appointment Booking setup. */
  setup: 'kb' | 'booking' | null;
}

const QA_PROMPT =
  "You answer customers' questions about our business: services, prices, opening hours, policies and how things work. Use the knowledge base for facts and keep answers short and friendly. When you don't know, say so and offer to have the team follow up.";
const BOOKING_PROMPT =
  'You help customers book an appointment. Find out what the visit is for, offer the open times that suit them, confirm the one they pick and make sure we have their name and email before booking.';

/** A new agent of this kind. `template` is the Marketplace template picked; `kbIds` are the knowledge bases a Q&A agent searches. */
export function agentPreset(kind: Exclude<AgentKind, 'market'> | PersonalityTemplate, kbIds: string[]): AgentPreset {
  const persona = (p: PersonalityTemplate) => ({ persona: { ...p.persona } });
  if (typeof kind !== 'string') {
    return { name: `${kind.label} ${newAgentName().slice('New Agent '.length)}`, config: { ...persona(kind), goals: { primary: kind.goal } }, knowledgeBaseIds: kbIds, setup: null };
  }
  const support = PERSONALITY_TEMPLATES.find((t) => t.id === 'support')!;
  const booking = PERSONALITY_TEMPLATES.find((t) => t.id === 'booking')!;
  if (kind === 'qa') return { name: newAgentName(), config: { ...persona(support), instructions: QA_PROMPT }, knowledgeBaseIds: kbIds, setup: 'kb' };
  if (kind === 'booking') return { name: newAgentName(), config: { ...persona(booking), instructions: BOOKING_PROMPT, goals: { primary: booking.goal } }, knowledgeBaseIds: [], setup: 'booking' };
  return { name: newAgentName(), config: {}, knowledgeBaseIds: [], setup: null };
}
