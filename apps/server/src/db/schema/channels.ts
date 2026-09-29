import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, pk, updatedAt } from './_helpers';
import { organizations } from './core';
import { bots } from './bots';

export type ChannelType = 'webchat' | 'api' | 'playground' | 'whatsapp' | 'messenger' | 'instagram' | 'sms' | 'email';

export interface WidgetTheme {
  primaryColor?: string;
  position?: 'right' | 'left';
  title?: string;
  subtitle?: string;
  avatarUrl?: string;
  launcherText?: string;
  /** Visitors may drag the bubble anywhere (while the chat is closed); `position` is where it starts. Off by default. */
  draggable?: boolean;
}

export interface ChannelAccountConfig {
  /** Widget: sites allowed to open sessions (exact origins, e.g. https://acme.com). Empty = any. */
  allowedOrigins?: string[];
  theme?: WidgetTheme;
  /** Overrides the bot greeting for this channel. */
  greeting?: string;
}

export const channelAccounts = pgTable(
  'channel_accounts',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    channel: text().$type<ChannelType>().notNull(),
    name: text().notNull(),
    /** Public identifier embedded in the widget snippet (`pk_…`). */
    publicKey: text().unique(),
    /** Provider-side id (WhatsApp phone_number_id, Facebook page id, …). */
    externalId: text(),
    botId: uuid().references(() => bots.id, { onDelete: 'set null' }),
    status: text().$type<'active' | 'disabled'>().notNull().default('active'),
    config: jsonb().$type<ChannelAccountConfig>().notNull().default({}),
    credentialsEnc: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('channel_accounts_org_idx').on(t.organizationId),
    uniqueIndex('channel_accounts_external_uq').on(t.channel, t.externalId).where(sql`${t.externalId} is not null`),
  ],
);
