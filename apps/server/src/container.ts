import { Redis } from 'ioredis';
import type { Env } from './config/env';
import { createDatabase, type Database, type Db } from './db/client';
import { runMigrations } from './db/migrate';
import { TenantDb } from './db/tenant';
import { LogEmailSender, ResendEmailSender, type EmailSender } from './infra/email';
import { MemoryLockService, RedisLockService, type LockService } from './infra/lock';
import { MemoryPubSub, RedisPubSub, type PubSub } from './infra/pubsub';
import { BullQueueDriver, InlineQueueDriver, type QueueDriver } from './infra/queue';
import { LocalStorageDriver, SupabaseStorageDriver, type StorageDriver } from './infra/storage';
import { SecretBox } from './lib/crypto';
import { createLogger, type Logger } from './lib/logger';
import { createLlmProvider } from './modules/ai/llm/registry';
import type { LlmProvider } from './modules/ai/llm/types';
import { AiOrchestrator, type ReplyJob } from './modules/ai/orchestrator';
import { PriceBook } from './modules/ai/pricing';
import { ConversationSummarizer, type SummaryJob } from './modules/ai/summary';
import { ApprovalsService } from './modules/approvals/service';
import { AuthService } from './modules/auth/service';
import { TokenService } from './modules/auth/tokens';
import { AutomationService } from './modules/automation/service';
import { BotsService } from './modules/bots/service';
import { ChannelRegistry } from './modules/channels/adapter';
import { ChannelsService } from './modules/channels/service';
import { ContactsService } from './modules/contacts/service';
import { AnalyticsService } from './modules/analytics/service';
import { UnansweredSweeper } from './modules/ai/sweeper';
import { HandoffWatcher } from './modules/handoff/service';
import { ConversationsService } from './modules/conversations/service';
import { DealsService } from './modules/deals/service';
import { LocalHashEmbeddingProvider, OpenAIEmbeddingProvider, type EmbeddingProvider } from './modules/knowledge/embeddings';
import { KnowledgeService } from './modules/knowledge/service';
import { QualificationService } from './modules/leads/qualification';
import { AppointmentEmailSender } from './modules/scheduling/notifications';
import { CalendarProviderRegistry } from './modules/scheduling/providers';
import { SchedulingService } from './modules/scheduling/service';
import { TenancyService } from './modules/tenancy/service';
import { createTools } from './modules/tools/definitions';
import { ToolExecutor } from './modules/tools/executor';

export interface ContainerOverrides {
  llm?: LlmProvider;
  /** Tests stand in for the Redis lock (e.g. to lose it mid-reply). */
  locks?: LockService;
  embeddings?: EmbeddingProvider;
  clock?: () => Date;
  logger?: Logger;
  /** Tests shrink retry backoffs of the in-process queue (0.01 = 100× faster). */
  inlineQueueTimeScale?: number;
  prices?: PriceBook;
}

/**
 * Composition root: the one place that knows which implementation backs each interface.
 * Local dev/tests: PGlite + in-process queue/locks/pub-sub. Production: Postgres + Redis.
 */
export async function createContainer(env: Env, overrides: ContainerOverrides = {}) {
  const logger = overrides.logger ?? createLogger(env);
  const database: Database = await createDatabase(env.DATABASE_URL, { poolMax: env.DATABASE_POOL_MAX });
  if (env.AUTO_MIGRATE) await runMigrations(database);
  const db: Db = database.db;
  const tenantDb = new TenantDb(db, env.DB_ENFORCE_RLS);

  let queue: QueueDriver;
  let locks: LockService;
  let pubsub: PubSub;
  const redisClients: Redis[] = [];
  if (env.REDIS_URL) {
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
    const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    redisClients.push(redis, subscriber);
    queue = new BullQueueDriver(env.REDIS_URL, logger);
    locks = overrides.locks ?? new RedisLockService(redis);
    pubsub = new RedisPubSub(redis, subscriber, logger);
  } else {
    if (!env.RUN_WORKERS_IN_API) throw new Error('Without REDIS_URL the workers must run in-process (RUN_WORKERS_IN_API=true)');
    queue = new InlineQueueDriver(logger, { timeScale: overrides.inlineQueueTimeScale });
    locks = overrides.locks ?? new MemoryLockService();
    pubsub = new MemoryPubSub();
  }

  const storage: StorageDriver =
    env.STORAGE_DRIVER === 'supabase'
      ? new SupabaseStorageDriver(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, env.SUPABASE_STORAGE_BUCKET)
      : new LocalStorageDriver(env.STORAGE_LOCAL_DIR);
  const email: EmailSender =
    env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY ? new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM) : new LogEmailSender(logger);
  const secrets = new SecretBox(env.ENCRYPTION_KEY);
  const embeddings: EmbeddingProvider =
    overrides.embeddings ??
    (env.EMBEDDINGS_PROVIDER === 'openai' && env.OPENAI_API_KEY
      ? new OpenAIEmbeddingProvider(env.OPENAI_API_KEY, env.EMBEDDINGS_MODEL)
      : new LocalHashEmbeddingProvider());
  const llm: LlmProvider = overrides.llm ?? createLlmProvider(env);
  const prices = overrides.prices ?? PriceBook.fromEnv(env, (model) =>
    logger.warn({ model }, 'No price configured for this model: its AI cost is recorded as $0 and budgets cannot be enforced (set LLM_PRICE_* or LLM_MODEL_PRICES)'),
  );
  const allowPrivateUrls = env.ALLOW_PRIVATE_URLS;
  const clock = overrides.clock;

  const tokens = new TokenService(env);
  const tenancy = new TenancyService(db, tenantDb, env);
  const auth = new AuthService(db, tenantDb, env, tokens, tenancy);
  const channelRegistry = new ChannelRegistry();
  const channels = new ChannelsService(db, tenantDb, env.PUBLIC_API_URL);
  const contacts = new ContactsService(tenantDb);
  const qualification = new QualificationService(tenantDb, contacts);
  const bots = new BotsService(tenantDb);
  const deals = new DealsService(tenantDb);
  const knowledge = new KnowledgeService(tenantDb, storage, embeddings, queue, logger, {
    allowPrivateUrls,
    maxUploadBytes: env.MAX_UPLOAD_MB * 1_000_000,
  });
  await knowledge.init(db);
  // Emails a booking change planned go out right after it commits; a timer catches reminders as they come due.
  const scheduling = new SchedulingService(tenantDb, new CalendarProviderRegistry(), clock, () =>
    void queue.add('appointment-email', {}, { jobId: 'appointment-email-now', delayMs: 250, attempts: 1, coalesce: true }).catch((err) => logger.error({ err }, 'could not queue appointment emails')),
  );
  const appointmentEmails = new AppointmentEmailSender(db, email, logger, clock);
  const automation = new AutomationService(db, tenantDb, queue, secrets, email, logger, {
    allowPrivateUrls,
    dashboardUrl: env.dashboardOrigins[0] ?? '',
    pubsub,
  });
  const conversations = new ConversationsService(tenantDb, contacts, queue, pubsub, channelRegistry, {
    replyDebounceMs: env.AI_REPLY_DEBOUNCE_MS,
    summaryIdleMs: env.AI_SUMMARY_IDLE_MINUTES * 60_000,
    onEventRecorded: () => automation.kick(),
  });
  const handoffWatcher = new HandoffWatcher(db, tenantDb, conversations, logger, () => automation.kick(), clock);
  const unansweredSweeper = new UnansweredSweeper(db, conversations, logger, clock);
  const analytics = new AnalyticsService(tenantDb, clock);
  const toolExecutor = new ToolExecutor(createTools({ contacts, qualification, knowledge, scheduling, automation, deals }), tenantDb, logger);
  const orchestrator = new AiOrchestrator({
    env,
    tenantDb,
    llm,
    locks,
    queue,
    bots,
    contacts,
    conversations,
    knowledge,
    qualification,
    scheduling,
    tools: toolExecutor,
    automation,
    deals,
    channels: channelRegistry,
    prices,
    logger,
    clock,
  });
  const approvals = new ApprovalsService({ tenantDb, tools: toolExecutor, bots, conversations, kick: () => automation.kick(), clock });
  const summarizer = new ConversationSummarizer(tenantDb, llm, prices, env, logger, async (orgId, conversationId, recap) => {
    await conversations.publish(orgId, { type: 'conversation.summary', conversationId });
    // A recap records `conversation.summarized`: send it on without waiting for the timer.
    if (recap) await automation.kick();
  });

  const timers: NodeJS.Timeout[] = [];

  /** Wires queue consumers. Runs in the worker process (or in the API process when there is no Redis). */
  function startWorkers() {
    queue.process<ReplyJob>('ai-reply', (job, meta) => orchestrator.handle(job, meta), { concurrency: 10 });
    queue.process<{ orgId: string; documentId: string }>('ingest', (job, meta) => knowledge.ingest(job.orgId, job.documentId, meta), { concurrency: 2 });
    queue.process<SummaryJob>('summary', (job) => summarizer.run(job), { concurrency: 2 });
    queue.process('events', async () => {
      while ((await automation.dispatchPending()) > 0) {
        // drain the backlog
      }
    }, { concurrency: 1 });
    queue.process<{ deliveryId: string }>('webhook-delivery', (job, meta) => automation.deliver(job.deliveryId, meta), { concurrency: 5 });
    queue.process<{ to: string[]; subject: string; text: string }>('notification', (job) => automation.sendEmail(job), { concurrency: 2 });
    queue.process<{ orgId: string; workflowId: string; body: unknown }>('workflow', (job) => automation.runQueuedWorkflow(job.orgId, job.workflowId, job.body), { concurrency: 5 });
    queue.process('appointment-email', async () => {
      await appointmentEmails.sendDue();
    }, { concurrency: 1 });
    void knowledge.reembedStale(db).catch((err) => logger.error({ err }, 're-embedding check failed'));
    // The outbox is also swept on a timer, so a missed nudge only delays delivery by a few seconds.
    if (env.NODE_ENV !== 'test') {
      timers.push(setInterval(() => void automation.kick().catch((err) => logger.error({ err }, 'dispatch kick failed')), 5_000));
      timers.push(setInterval(() => void automation.retryStalledDeliveries().catch((err) => logger.error({ err }, 'stalled retry failed')), 300_000));
      // Website documents set to refresh daily or weekly; checked at start and every 10 minutes.
      const refreshWebsites = () => void knowledge.enqueueDueRefreshes(db).catch((err) => logger.error({ err }, 'website refresh check failed'));
      refreshWebsites();
      timers.push(setInterval(refreshWebsites, 600_000));
      // Reminders (and any email whose send failed and is waiting to retry) every minute.
      // Handed-off chats nobody has answered within their bot's limit, every minute.
      timers.push(setInterval(() => void handoffWatcher.escalateOverdue().catch((err) => logger.error({ err }, 'handoff watch failed')), 60_000));
      // Customer messages the AI never answered (nothing queued, or the job died): queued again every minute.
      timers.push(setInterval(() => void unansweredSweeper.run().catch((err) => logger.error({ err }, 'unanswered-message sweep failed')), 60_000));
      timers.push(setInterval(() => void appointmentEmails.sendDue().catch((err) => logger.error({ err }, 'appointment email run failed')), 60_000));
    }
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    await queue.close();
    await pubsub.close();
    await Promise.allSettled(redisClients.map((r) => r.quit()));
    await database.close();
  }

  return {
    env,
    logger,
    /** The current time (fixed in tests). */
    now: clock ?? (() => new Date()),
    database,
    db,
    tenantDb,
    queue,
    locks,
    pubsub,
    storage,
    email,
    secrets,
    llm,
    prices,
    embeddings,
    tokens,
    tenancy,
    auth,
    channels,
    channelRegistry,
    contacts,
    qualification,
    bots,
    knowledge,
    scheduling,
    appointmentEmails,
    handoffWatcher,
    unansweredSweeper,
    analytics,
    automation,
    conversations,
    deals,
    approvals,
    toolExecutor,
    orchestrator,
    summarizer,
    startWorkers,
    close,
  };
}

export type Container = Awaited<ReturnType<typeof createContainer>>;
