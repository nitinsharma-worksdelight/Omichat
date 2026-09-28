import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg, createTestEnv, type TestEnv } from './helpers';

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

describe('knowledge base / RAG', () => {
  it('ingests documents and retrieves the right chunk with hybrid search', async () => {
    const org = await createOrg(t.c);
    await t.c.knowledge.createTextDocument(org.scope, org.kb.id, {
      title: 'Pricing',
      category: 'pricing',
      content: '# Plans\n\n## Starter\n\nThe Starter plan costs $19 per month and includes 1 user.\n\n## Business\n\nThe Business plan costs $99 per month with unlimited users and priority support.',
    });
    await t.c.knowledge.createFaqDocument(org.scope, org.kb.id, {
      title: 'FAQ',
      category: 'faq',
      faq: [
        { question: 'What is your refund policy?', answer: 'Full refund within 30 days of purchase, no questions asked.' },
        { question: 'Do you offer SKU AB-1042 in blue?', answer: 'Yes, AB-1042 ships in blue and black.' },
      ],
    });
    await t.c.queue.drain();
    const docs = await t.c.knowledge.listDocuments(org.scope, org.kb.id);
    expect(docs.map((d) => d.status)).toEqual(['ready', 'ready']);

    const refund = await t.c.knowledge.search(org.scope, { knowledgeBaseIds: [org.kb.id], query: 'can I get my money back? refund' });
    expect(refund.chunks[0]!.content).toContain('30 days');
    expect(refund.grounding).toBe('grounded');

    const business = await t.c.knowledge.search(org.scope, { knowledgeBaseIds: [org.kb.id], query: 'how much is the business plan per month' });
    expect(business.chunks[0]!.title).toContain('Business');

    const sku = await t.c.knowledge.search(org.scope, { knowledgeBaseIds: [org.kb.id], query: 'AB-1042' });
    expect(sku.chunks[0]!.content).toContain('AB-1042');
  });

  it('never returns another tenant\'s chunks', async () => {
    const a = await createOrg(t.c);
    const b = await createOrg(t.c);
    await t.c.knowledge.createTextDocument(b.scope, b.kb.id, { title: 'Secret', category: 'general', content: 'The vault combination is 1234 for Beta Corp.' });
    await t.c.queue.drain();
    // Even when org A passes org B's knowledge-base id.
    const res = await t.c.knowledge.search(a.scope, { knowledgeBaseIds: [b.kb.id], query: 'vault combination' });
    expect(res.chunks).toEqual([]);
  });

  it('re-ingesting replaces chunks, and unchanged content is skipped', async () => {
    const org = await createOrg(t.c);
    const doc = await t.c.knowledge.createTextDocument(org.scope, org.kb.id, { title: 'Hours', category: 'general', content: 'We open at 9am.' });
    await t.c.queue.drain();
    await t.c.knowledge.updateDocument(org.scope, doc.id, { content: 'We open at 10am on weekdays.' });
    await t.c.queue.drain();
    const chunks = await t.c.knowledge.listChunks(org.scope, doc.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('10am');
  });

  it('a new category applies to search straight away, without re-ingesting', async () => {
    const org = await createOrg(t.c);
    const doc = await t.c.knowledge.createTextDocument(org.scope, org.kb.id, { title: 'Hours', category: 'general', content: 'We open at 9am on weekdays and 10am on Saturdays.' });
    await t.c.queue.drain();
    const chunkIds = (await t.c.knowledge.listChunks(org.scope, doc.id)).map((c) => c.id);
    expect((await t.c.knowledge.updateDocument(org.scope, doc.id, { category: 'policies' })).status).toBe('ready');
    await t.c.queue.drain();
    const found = await t.c.knowledge.search(org.scope, { knowledgeBaseIds: [org.kb.id], query: 'when do you open', category: 'policies' });
    expect(found.chunks.map((c) => [c.documentId, c.category])).toEqual([[doc.id, 'policies']]);
    expect((await t.c.knowledge.listChunks(org.scope, doc.id)).map((c) => c.id)).toEqual(chunkIds);
  });

  it('marks unreadable uploads as failed with a reason', async () => {
    const org = await createOrg(t.c);
    const doc = await t.c.knowledge.createFileDocument(org.scope, org.kb.id, {
      filename: 'broken.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('not really a pdf'),
    });
    await t.c.queue.drain();
    const after = await t.c.knowledge.getDocument(org.scope, doc.id);
    expect(after.status).toBe('failed');
    expect(after.error).toBeTruthy();
  });
});
