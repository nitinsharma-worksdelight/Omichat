import { schema, type Db } from '../../db/client';
import type { WeeklyHours } from '../../db/schema';
import { randomToken } from '../../lib/ids';
import { BotConfigSchema } from '../bots/config';
import { createDefaultPipeline } from '../deals/service';

export const DEFAULT_LIFECYCLE_STAGES = ['new', 'engaged', 'qualified', 'unqualified', 'booked', 'customer', 'lost'];

export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: [{ start: '09:00', end: '17:00' }],
  tue: [{ start: '09:00', end: '17:00' }],
  wed: [{ start: '09:00', end: '17:00' }],
  thu: [{ start: '09:00', end: '17:00' }],
  fri: [{ start: '09:00', end: '17:00' }],
};

/** Starter resources so a new organization can chat on its website within minutes. */
export async function bootstrapOrganization(
  tx: Db,
  org: { id: string; name: string; timezone: string },
): Promise<{ botId: string; channelAccountId: string; knowledgeBaseId: string; calendarId: string }> {
  const [kb] = await tx
    .insert(schema.knowledgeBases)
    .values({ organizationId: org.id, name: 'General', description: 'FAQs, services, pricing and policies' })
    .returning({ id: schema.knowledgeBases.id });

  const [calendar] = await tx
    .insert(schema.calendars)
    .values({ organizationId: org.id, name: 'Main calendar', timezone: org.timezone, weeklyHours: DEFAULT_WEEKLY_HOURS })
    .returning({ id: schema.calendars.id });

  const config = BotConfigSchema.parse({
    persona: { companyName: org.name },
    booking: { enabled: false, calendarId: calendar!.id },
  });
  const [bot] = await tx
    .insert(schema.bots)
    // No model or effort stored: the bot follows the server's LLM configuration until someone overrides it.
    .values({ organizationId: org.id, name: 'Website Assistant', config })
    .returning({ id: schema.bots.id });

  await tx.insert(schema.botKnowledgeBases).values({ organizationId: org.id, botId: bot!.id, knowledgeBaseId: kb!.id });

  const [channel] = await tx
    .insert(schema.channelAccounts)
    .values({
      organizationId: org.id,
      channel: 'webchat',
      name: 'Website chat',
      publicKey: randomToken('pk', 18),
      botId: bot!.id,
      config: { allowedOrigins: [], theme: { primaryColor: '#4f46e5', position: 'right', title: org.name } },
    })
    .returning({ id: schema.channelAccounts.id });

  await tx.insert(schema.channelAccounts).values({
    organizationId: org.id,
    channel: 'playground',
    name: 'Dashboard playground',
    botId: bot!.id,
  });

  await createDefaultPipeline(tx, org.id);

  return { botId: bot!.id, channelAccountId: channel!.id, knowledgeBaseId: kb!.id, calendarId: calendar!.id };
}
