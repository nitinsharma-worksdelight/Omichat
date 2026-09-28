import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type {
  AiConfig,
  Bot,
  Calendar,
  Channel,
  CustomFieldDef,
  KnowledgeBase,
  KnowledgeLanguage,
  Me,
  Member,
  Organization,
  Pipeline,
  Role,
  Tag,
  Workflow,
} from './types';

/** Shared reads used across several pages. Page-specific queries live next to their pages. */

export const useMe = (enabled = true) => useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/v1/me'), enabled, staleTime: 60_000 });
export const useOrg = () => useQuery({ queryKey: ['org'], queryFn: () => get<Organization>('/v1/org'), staleTime: 60_000 });
export const useAiConfig = () => useQuery({ queryKey: ['ai-config'], queryFn: () => get<AiConfig>('/v1/ai/config'), staleTime: 300_000 });
export const useBots = () => useQuery({ queryKey: ['bots'], queryFn: () => get<Bot[]>('/v1/bots') });
export const useCustomFields = () => useQuery({ queryKey: ['custom-fields'], queryFn: () => get<CustomFieldDef[]>('/v1/custom-fields') });
export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: () => get<Tag[]>('/v1/tags') });
export const useCalendars = () => useQuery({ queryKey: ['calendars'], queryFn: () => get<Calendar[]>('/v1/calendars') });
export const useKnowledgeBases = () => useQuery({ queryKey: ['kbs'], queryFn: () => get<KnowledgeBase[]>('/v1/knowledge-bases') });
/** The database's keyword-search languages; fixed for a server's lifetime. */
export const useKnowledgeLanguages = () =>
  useQuery({ queryKey: ['kb-languages'], queryFn: () => get<KnowledgeLanguage[]>('/v1/knowledge/languages'), staleTime: Infinity });
export const useChannels = () => useQuery({ queryKey: ['channels'], queryFn: () => get<Channel[]>('/v1/channels') });
export const useMembers = () => useQuery({ queryKey: ['members'], queryFn: () => get<Member[]>('/v1/members'), staleTime: 60_000 });
export const usePipelines = () => useQuery({ queryKey: ['pipelines'], queryFn: () => get<Pipeline[]>('/v1/pipelines') });
/** Admin-only endpoint; pass `enabled=false` for lower roles. */
export const useWorkflows = (enabled = true) =>
  useQuery({ queryKey: ['workflows'], queryFn: () => get<Workflow[]>('/v1/workflows'), enabled });

const RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };
export const roleAtLeast = (role: Role | undefined, minimum: Role) => (role ? RANK[role] >= RANK[minimum] : false);
