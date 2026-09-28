/**
 * Talk to the demo bot from the terminal with the real LLM — the quickest way to check prompts and tools.
 *   npm run chat -w @omni/server      (uses LLM_PROVIDER / LLM_MODEL / API key from apps/server/.env)
 * Uses a throwaway in-memory database seeded with the "Bright Smile Dental" demo.
 */
import { createInterface } from 'node:readline/promises';
import { loadEnv } from '../config/env';
import { createContainer } from '../container';
import { seedDemo } from '../db/seed';
import { convChannel, type RealtimeEvent } from '../modules/conversations/service';

// No quiet-spell recaps: each message waits for the queue to empty, and a recap would hold it for the whole quiet spell.
const env = loadEnv({ DATABASE_URL: process.env.CHAT_DATABASE_URL ?? 'pglite://memory', LOG_LEVEL: 'warn', AI_REPLY_DEBOUNCE_MS: '0', AI_SUMMARY_IDLE_MINUTES: '0', REDIS_URL: '' });
env.REDIS_URL = undefined;
const c = await createContainer(env);
c.startWorkers();
const { orgId } = await seedDemo(c);
await c.queue.drain();
const channel = (await c.channels.list({ orgId })).find((ch) => ch.channel === 'webchat')!;
const visitor = `cli-${Date.now()}`;
console.log(`\nChatting with the demo bot (${c.llm.info.provider} · ${c.llm.info.model}). Type a message; "exit" to quit.\n`);
if (c.llm.name === 'mock') console.log('No LLM provider configured: replies are placeholders.\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });
let unsubscribe: (() => void) | null = null;
let seen = 0;
for (;;) {
  let text: string;
  try {
    text = (await rl.question('you › ')).trim();
  } catch {
    break; // stdin closed
  }
  if (!text || text === 'exit') break;
  const result = await c.conversations.receiveInbound({ orgId, channelAccountId: channel.id, externalUserId: visitor, content: text });
  if (!unsubscribe) {
    unsubscribe = c.pubsub.subscribe(convChannel(result.conversationId), (raw) => {
      const e = raw as RealtimeEvent;
      if (e.type === 'ai.typing') process.stdout.write('bot › ');
      if (e.type === 'ai.delta') process.stdout.write(e.text);
      if (e.type === 'ai.activity') process.stdout.write(`\x1b[2m[${e.label}]\x1b[0m `);
      if (e.type === 'conversation.status') process.stdout.write(`\n\x1b[33m[conversation → ${e.status}${e.reason ? `: ${e.reason}` : ''}]\x1b[0m`);
    });
  }
  await c.queue.drain();
  process.stdout.write('\n');
  const tools = await c.conversations.toolInvocations({ orgId }, result.conversationId);
  for (const t of tools.slice(seen)) {
    console.log(`\x1b[36m  ⚙ ${t.toolName} ${t.status}\x1b[0m ${JSON.stringify(t.input)}${t.error ? `  → ${t.error}` : ''}`);
  }
  seen = tools.length;
  const contact = await c.contacts.get({ orgId }, result.contactId);
  console.log(
    `\x1b[2m  contact: ${contact.name ?? '—'} · ${contact.phone ?? '—'} · ${contact.email ?? '—'} · qualification ${contact.qualificationStatus} (${contact.leadScore}, ${contact.leadTier ?? '—'}) · stage ${contact.lifecycleStage}\x1b[0m\n`,
  );
}
rl.close();
unsubscribe?.();
await c.close();
