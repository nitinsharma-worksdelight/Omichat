import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '../../db/client';
import type { ChannelAccountConfig, ChannelType } from '../../db/schema';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import { badRequest, notFound } from '../../lib/errors';
import { randomToken } from '../../lib/ids';

const OriginSchema = z
  .string()
  .trim()
  .transform((o) => o.replace(/\/+$/, ''))
  .refine((o) => /^https?:\/\/[^/\s]+$/.test(o), 'origins look like https://example.com (no path)');

export const WebchatChannelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  botId: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  config: z
    .object({
      allowedOrigins: z.array(OriginSchema).max(50).optional(),
      greeting: z.string().max(500).optional(),
      // Send "" or null for a theme field to clear it.
      theme: z
        .object({
          primaryColor: z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.literal('')]).nullable().optional(),
          position: z.enum(['right', 'left']).nullable().optional(),
          title: z.string().max(80).nullable().optional(),
          subtitle: z.string().max(120).nullable().optional(),
          avatarUrl: z.union([z.string().url().max(500), z.literal('')]).nullable().optional(),
          launcherText: z.string().max(40).nullable().optional(),
          draggable: z.boolean().nullable().optional(),
        })
        .optional(),
    })
    .optional(),
});

type ChannelRow = typeof schema.channelAccounts.$inferSelect;

/** The greeting a web chat opens with, exactly as the widget shows it: the channel's own, else the bot's. */
export function openingGreeting(config: ChannelAccountConfig, bot: { config: { persona: { greeting: string } } } | null): string {
  return config.greeting || bot?.config.persona.greeting || 'Hi! How can I help?';
}
type ConfigInput = NonNullable<z.infer<typeof WebchatChannelSchema>['config']>;

/** Shallow-merges config (and its theme); empty/null theme values remove the field. */
function mergeConfig(current: ChannelAccountConfig, patch: ConfigInput): ChannelAccountConfig {
  const { theme: themePatch, ...rest } = patch;
  const theme: Record<string, unknown> = { ...current.theme, ...themePatch };
  for (const [key, value] of Object.entries(theme)) if (value === '' || value === null || value === undefined) delete theme[key];
  return { ...current, ...rest, theme: theme as ChannelAccountConfig['theme'] };
}

export class ChannelsService {
  /**
   * `publicApiUrl` is PUBLIC_API_URL when set. Otherwise the embed code uses the `baseUrl` the caller passes: the
   * address the request came in on. Without either, views carry no embed code.
   */
  constructor(
    private readonly db: Db,
    private readonly tenantDb: TenantDb,
    private readonly publicApiUrl?: string,
  ) {}

  async list(scope: Scope, baseUrl?: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.channelAccounts)
        .where(eq(schema.channelAccounts.organizationId, scope.orgId))
        .orderBy(asc(schema.channelAccounts.createdAt));
      return rows.map((r) => this.view(r, baseUrl));
    });
  }

  async get(scope: Scope, id: string, baseUrl?: string) {
    return inScope(this.tenantDb, scope, async (tx) => this.view(await this.row(tx, scope.orgId, id), baseUrl));
  }

  async createWebchat(scope: Scope, input: z.infer<typeof WebchatChannelSchema>, baseUrl?: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      if (input.botId) await this.assertBot(tx, scope.orgId, input.botId);
      const [row] = await tx
        .insert(schema.channelAccounts)
        .values({
          organizationId: scope.orgId,
          channel: 'webchat',
          name: input.name,
          publicKey: randomToken('pk', 18),
          botId: input.botId ?? null,
          status: input.status ?? 'active',
          config: mergeConfig({}, input.config ?? {}),
        })
        .returning();
      return this.view(row!, baseUrl);
    });
  }

  async update(scope: Scope, id: string, input: Partial<z.infer<typeof WebchatChannelSchema>>, baseUrl?: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const current = await this.row(tx, scope.orgId, id);
      if (input.botId) await this.assertBot(tx, scope.orgId, input.botId);
      const config = input.config ? mergeConfig(current.config, input.config) : current.config;
      const [row] = await tx
        .update(schema.channelAccounts)
        .set({ name: input.name, botId: input.botId, status: input.status, config })
        .where(eq(schema.channelAccounts.id, id))
        .returning();
      return this.view(row!, baseUrl);
    });
  }

  /** New widget key; embeds using the old key stop working immediately. */
  async rotateKey(scope: Scope, id: string, baseUrl?: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const current = await this.row(tx, scope.orgId, id);
      if (current.channel !== 'webchat') throw badRequest('Only website chat channels have keys');
      const [row] = await tx
        .update(schema.channelAccounts)
        .set({ publicKey: randomToken('pk', 18) })
        .where(eq(schema.channelAccounts.id, id))
        .returning();
      return this.view(row!, baseUrl);
    });
  }

  async delete(scope: Scope, id: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const current = await this.row(tx, scope.orgId, id);
      if (current.channel === 'playground') throw badRequest('The playground channel cannot be deleted');
      await tx.delete(schema.channelAccounts).where(eq(schema.channelAccounts.id, id));
    });
  }

  /** Public lookup by widget key (no tenant yet — the key is how we find it). */
  async byPublicKey(publicKey: string): Promise<ChannelRow | null> {
    const [row] = await this.db
      .select()
      .from(schema.channelAccounts)
      .where(and(eq(schema.channelAccounts.publicKey, publicKey), eq(schema.channelAccounts.channel, 'webchat')));
    return row ?? null;
  }

  /** The org's singleton channel of a given kind (playground, api), created on first use. */
  async ensureSystemChannel(orgId: string, channel: Extract<ChannelType, 'playground' | 'api'>): Promise<ChannelRow> {
    return this.tenantDb.run(orgId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.channelAccounts)
        .where(and(eq(schema.channelAccounts.organizationId, orgId), eq(schema.channelAccounts.channel, channel)));
      if (existing) return existing;
      const [defaultBot] = await tx.select({ id: schema.bots.id }).from(schema.bots).where(eq(schema.bots.organizationId, orgId)).limit(1);
      const [row] = await tx
        .insert(schema.channelAccounts)
        .values({
          organizationId: orgId,
          channel,
          name: channel === 'api' ? 'Public API' : 'Dashboard playground',
          botId: defaultBot?.id ?? null,
        })
        .returning();
      return row!;
    });
  }

  embedSnippet(publicKey: string, apiUrl: string): string {
    return `<script src="${apiUrl}/widget.js" data-key="${publicKey}" async></script>`;
  }

  private view(r: ChannelRow, baseUrl?: string) {
    const apiUrl = this.publicApiUrl ?? baseUrl?.replace(/\/+$/, '');
    return {
      id: r.id,
      channel: r.channel,
      name: r.name,
      publicKey: r.publicKey,
      botId: r.botId,
      status: r.status,
      config: r.config,
      embedSnippet: r.channel === 'webchat' && r.publicKey && apiUrl ? this.embedSnippet(r.publicKey, apiUrl) : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private async row(tx: Db, orgId: string, id: string): Promise<ChannelRow> {
    const [row] = await tx
      .select()
      .from(schema.channelAccounts)
      .where(and(eq(schema.channelAccounts.id, id), eq(schema.channelAccounts.organizationId, orgId)));
    if (!row) throw notFound('Channel');
    return row;
  }

  private async assertBot(tx: Db, orgId: string, botId: string) {
    const [bot] = await tx.select({ id: schema.bots.id }).from(schema.bots).where(and(eq(schema.bots.id, botId), eq(schema.bots.organizationId, orgId)));
    if (!bot) throw notFound('Bot');
  }
}
