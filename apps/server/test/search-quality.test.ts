import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { lexicalTokens } from '../src/modules/knowledge/embeddings';
import { searchTerms } from '../src/modules/knowledge/service';
import { evaluateSearch, formatScores, seedSearchSet, type SearchGroup } from './fixtures/search-set';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

/**
 * Knowledge-base search quality: a question set with floors (local embedder, so this guards keyword search, word
 * splitting and chunking; production quality is measured with `npm run search-eval`), keyword search in each
 * knowledge base's language, whole words in every script, and website sources that stay current.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;

async function titlesFound(org: Org, kbIds: string[], query: string) {
  const result = await t.c.knowledge.search(org.scope, { knowledgeBaseIds: kbIds, query, limit: 5 });
  const docs = new Map<string, string>();
  for (const kb of kbIds) for (const d of await t.c.knowledge.listDocuments(org.scope, kb)) docs.set(d.id, d.title);
  return result.chunks.map((c) => docs.get(c.documentId));
}

describe('search quality on the question set (local embedder)', () => {
  // The local embedder after Phase 8 scores English 13/16 first (14 in the top 5), Spanish 5/5, Hindi 4/4 and
  // Hinglish 2/3. English gets one question of slack; lowering a floor should be a deliberate choice.
  // Production numbers (OpenAI embeddings) come from `npm run search-eval`; cross-language needs a real embedder.
  const FLOORS: Partial<Record<SearchGroup, { first: number; top5: number }>> = {
    english: { first: 12, top5: 13 },
    spanish: { first: 5, top5: 5 },
    hindi: { first: 4, top5: 4 },
    hinglish: { first: 2, top5: 2 },
  };

  it('finds the right document at least as often as the floors', async () => {
    const env = await createTestEnv();
    try {
      const seeded = await seedSearchSet(env.c);
      const { scores, misses } = await evaluateSearch(env.c, seeded);
      const report = `${formatScores(scores)}\n${misses.join('\n')}`;
      for (const [group, floor] of Object.entries(FLOORS) as Array<[SearchGroup, { first: number; top5: number }]>) {
        expect(scores[group].first, `${group}: right document first\n${report}`).toBeGreaterThanOrEqual(floor.first);
        expect(scores[group].top5, `${group}: in top 5\n${report}`).toBeGreaterThanOrEqual(floor.top5);
      }
    } finally {
      await env.close();
    }
  });
});

describe('keyword search in every language', () => {
  it('keeps Hindi and Tamil words whole', () => {
    expect(searchTerms('दाँत सफेद करने की कीमत')).toEqual(['दाँत', 'सफेद', 'करने', 'की', 'कीमत']);
    expect(searchTerms('பல் சுத்தம் விலை')).toEqual(['பல்', 'சுத்தம்', 'விலை']);
    expect(lexicalTokens('सफेद दाँत')).toEqual(['सफेद', 'दाँत']);
  });

  it('finds a Hindi passage by one of its words', async () => {
    const org = await createOrg(t.c, 'Hindi Clinic');
    // Long enough that the one shared word alone doesn't make the local embedder's cut: keyword search must find it.
    const content = [
      'हमारे क्लिनिक में परिवार के सभी सदस्यों के लिए दाँतों की पूरी देखभाल होती है। नियमित जाँच, सफाई, एक्स-रे, फिलिंग, रूट कैनाल और ब्रेसेस उपलब्ध हैं।',
      'बच्चों के लिए हमारे पास अलग कमरा है, जहाँ खिलौने और किताबें रखी गई हैं। डॉक्टर बच्चों से प्यार से बात करते हैं ताकि उन्हें डर न लगे।',
      'दाँत सफेद करने की कीमत 450 डॉलर है और घर पर इस्तेमाल होने वाली किट 300 डॉलर में मिलती है। पहली मुलाक़ात में पूरी जाँच शामिल है।',
      'हम ज़्यादातर बीमा योजनाएँ स्वीकार करते हैं और बिल सीधे आपकी बीमा कंपनी को भेजते हैं। पार्किंग इमारत के पीछे मुफ़्त है।',
      'अगर आपको अपॉइंटमेंट रद्द करना है तो कृपया चौबीस घंटे पहले बताएँ। आपात स्थिति में उसी दिन मिलने की कोशिश की जाती है।',
    ].join(' ');
    await t.c.knowledge.createTextDocument(org.scope, org.kb.id, { title: 'सेवाएँ', category: 'pricing', content });
    await t.c.queue.drain();
    expect(await titlesFound(org, [org.kb.id], 'कीमत')).toContain('सेवाएँ');
  });

  it('stems Spanish in a knowledge base set to Spanish, and English ones behave as before', async () => {
    const org = await createOrg(t.c, 'Spanish Clinic');
    const spanish = await t.c.knowledge.createKnowledgeBase(org.scope, { name: 'Español', description: '', language: 'spanish' });
    const content = 'Los tratamientos de ortodoncia cuestan 450 dólares e incluyen revisiones mensuales.';
    await t.c.knowledge.createTextDocument(org.scope, spanish.id, { title: 'Precios', category: 'pricing', content });
    await t.c.knowledge.createTextDocument(org.scope, org.kb.id, { title: 'Precios (inglés)', category: 'pricing', content });
    await t.c.queue.drain();
    expect(await titlesFound(org, [spanish.id], '¿Cuánto cuesta?')).toContain('Precios');
    expect(await titlesFound(org, [org.kb.id], '¿Cuánto cuesta?')).not.toContain('Precios (inglés)');
  });

  it("rebuilds a knowledge base's keyword index when its language changes, and no other's", async () => {
    const org = await createOrg(t.c, 'Switch Clinic');
    const other = await t.c.knowledge.createKnowledgeBase(org.scope, { name: 'Other', description: '' });
    const content = 'Los tratamientos de ortodoncia cuestan 450 dólares.';
    await t.c.knowledge.createTextDocument(org.scope, org.kb.id, { title: 'Precios', category: 'pricing', content });
    await t.c.knowledge.createTextDocument(org.scope, other.id, { title: 'Precios otros', category: 'pricing', content });
    await t.c.queue.drain();
    expect(await titlesFound(org, [org.kb.id], 'cuesta')).not.toContain('Precios');

    const res = await t.app.inject({ method: 'PATCH', url: `/v1/knowledge-bases/${org.kb.id}`, headers: authHeaders(org.token), payload: { language: 'spanish' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().language).toBe('spanish');
    expect(await titlesFound(org, [org.kb.id], 'cuesta')).toContain('Precios');
    expect(await titlesFound(org, [other.id], 'cuesta')).not.toContain('Precios otros');
  });

  it('refuses a language the database has no dictionary for, and lists the ones it has', async () => {
    const org = await createOrg(t.c, 'Klingon Clinic');
    const bad = await t.app.inject({ method: 'POST', url: '/v1/knowledge-bases', headers: authHeaders(org.token), payload: { name: 'KB', language: 'klingon' } });
    expect(bad.statusCode).toBe(400);
    const list = await t.app.inject({ method: 'GET', url: '/v1/knowledge/languages', headers: authHeaders(org.token) });
    expect(list.json().map((l: { value: string }) => l.value)).toEqual(expect.arrayContaining(['english', 'spanish', 'hindi', 'simple']));
  });

  it('tells the model which language the documents are in', async () => {
    const org = await createOrg(t.c, 'Prompt Clinic');
    const spanish = await t.c.knowledge.createKnowledgeBase(org.scope, { name: 'Español', description: '', language: 'spanish' });
    await t.c.bots.update(org.scope, org.bot.id, { knowledgeBaseIds: [org.kb.id, spanish.id] });
    t.llm.setScript([text('Hi!')]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'lang', content: 'Hello' });
    await t.c.queue.drain();
    expect(t.llm.requests[0]!.system).toMatch(/documents are in English and Spanish/);
  });
});

describe('website sources stay current', () => {
  it('refreshes a URL document when due: unchanged pages keep their chunks, changed ones are replaced, failures keep the last good content', async () => {
    let price = '$450';
    let status = 200;
    const server = createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader('content-type', 'text/html');
      res.end(
        `<html><head><title>Prices</title></head><body><main><h1>Prices</h1><p>Teeth whitening costs ${price} per visit. Invisalign starts at $3,900 and includes a free consultation.</p></main></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const HOUR = 3_600_000;
      const org = await createOrg(t.c, 'Refresh Clinic');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prices`;
      const doc = await t.c.knowledge.createUrlDocument(org.scope, org.kb.id, { url, crawl: false, maxPages: 1, category: 'pricing', refreshIntervalHours: 24 });
      const quiet = await t.c.knowledge.createUrlDocument(org.scope, org.kb.id, { url: `${url}?copy`, crawl: false, maxPages: 1, category: 'pricing' });
      await t.c.queue.drain();

      const row = async (id: string) => (await t.c.db.select().from(schema.documents).where(eq(schema.documents.id, id)))[0]!;
      const chunks = (id: string) =>
        t.c.db.select().from(schema.documentChunks).where(eq(schema.documentChunks.documentId, id)).orderBy(asc(schema.documentChunks.chunkIndex));
      // Both are made overdue; only the one set to refresh is picked up.
      const due = async () => {
        await t.c.db.update(schema.documents).set({ nextRefreshAt: new Date(Date.now() - 1000) }).where(inArray(schema.documents.id, [doc.id, quiet.id]));
        await t.c.knowledge.enqueueDueRefreshes(t.c.db);
        await t.c.queue.drain();
      };
      expect((await row(doc.id)).nextRefreshAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
      expect((await row(quiet.id)).nextRefreshAt).toBeNull();
      const firstIds = (await chunks(doc.id)).map((c) => c.id);
      const quietIngestedAt = (await row(quiet.id)).lastIngestedAt;

      // Page unchanged: nothing re-embedded, and the next refresh moves on a day.
      await due();
      expect((await chunks(doc.id)).map((c) => c.id)).toEqual(firstIds);
      expect((await row(doc.id)).nextRefreshAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);

      // Page changed: the chunks are replaced.
      price = '$500';
      await due();
      expect((await chunks(doc.id)).map((c) => c.content).join(' ')).toContain('$500');

      // Site down: the last good content stays searchable, and it's tried again within 6 hours.
      status = 500;
      await due();
      expect((await chunks(doc.id)).map((c) => c.content).join(' ')).toContain('$500');
      const failed = await row(doc.id);
      expect(failed.status).toBe('failed');
      expect(failed.nextRefreshAt!.getTime()).toBeGreaterThan(Date.now());
      expect(failed.nextRefreshAt!.getTime()).toBeLessThanOrEqual(Date.now() + 6 * HOUR);
      expect((await row(quiet.id)).lastIngestedAt).toEqual(quietIngestedAt);

      // A new schedule for a failed page keeps its quick retry.
      const patch = (id: string, payload: object) => t.app.inject({ method: 'PATCH', url: `/v1/documents/${id}`, headers: authHeaders(org.token), payload });
      const failedWeekly = await patch(doc.id, { refreshIntervalHours: 168 });
      expect(failedWeekly.json()).toMatchObject({ refreshIntervalHours: 168, status: 'failed' });
      expect(new Date(failedWeekly.json().nextRefreshAt).getTime()).toBeLessThanOrEqual(Date.now() + 6 * HOUR);

      // Turning it on for a healthy page schedules it from the last fetch, without re-fetching; off clears it.
      const weekly = await patch(quiet.id, { refreshIntervalHours: 168 });
      expect(weekly.statusCode).toBe(200);
      expect(weekly.json()).toMatchObject({ refreshIntervalHours: 168, status: 'ready' });
      expect(new Date(weekly.json().nextRefreshAt).getTime()).toBeGreaterThan(Date.now() + 160 * HOUR);
      expect((await patch(quiet.id, { refreshIntervalHours: null })).json()).toMatchObject({ refreshIntervalHours: null, nextRefreshAt: null });
      expect((await patch(quiet.id, { refreshIntervalHours: 12 })).statusCode).toBe(400);

      // Only website documents refresh.
      const note = await t.app.inject({
        method: 'POST',
        url: `/v1/knowledge-bases/${org.kb.id}/documents`,
        headers: authHeaders(org.token),
        payload: { type: 'text', title: 'Note', content: 'Hello there', refreshIntervalHours: 24 },
      });
      expect(note.statusCode).toBe(400);
      const plain = await t.c.knowledge.createTextDocument(org.scope, org.kb.id, { title: 'Note', content: 'Hello there', category: 'general' });
      expect((await patch(plain.id, { refreshIntervalHours: 24 })).statusCode).toBe(400);
    } finally {
      server.close();
    }
  });
});
