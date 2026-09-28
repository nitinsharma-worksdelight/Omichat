import type { Container } from '../../src/container';
import { seedDemo } from '../../src/db/seed';

/**
 * A fixed question set for knowledge-base search: customer-style questions (paraphrases, synonyms, other
 * languages) paired with the documents that count as a right answer. It runs against the Bright Smile Dental
 * demo plus a small Spanish and a Hindi FAQ, each in a knowledge base set to its own language. Shared by the
 * CI test (local embedder, free) and `npm run search-eval` (the configured embedder).
 */

export const DOCS = {
  pricing: 'Services and pricing',
  faq: 'Frequently asked questions',
  policies: 'Policies',
  spanishFaq: 'Preguntas frecuentes',
  hindiFaq: 'अक्सर पूछे जाने वाले प्रश्न',
} as const;

/** `cross-language`: the answer exists only in another language; reported, not enforced with the dev embedder. */
export type SearchGroup = 'english' | 'spanish' | 'hindi' | 'hinglish' | 'cross-language';

export const SEARCH_SET: Array<{ group: SearchGroup; question: string; expect: string[] }> = [
  { group: 'english', question: 'How much does teeth whitening cost?', expect: [DOCS.pricing] },
  { group: 'english', question: "what's the price for invisalign", expect: [DOCS.pricing] },
  { group: 'english', question: 'Do you take my insurance? I have Manulife', expect: [DOCS.faq] },
  { group: 'english', question: 'When are you open on weekends?', expect: [DOCS.faq] },
  { group: 'english', question: 'where is your clinic located', expect: [DOCS.faq] },
  { group: 'english', question: 'I have a terrible toothache and my face is swollen', expect: [DOCS.faq] },
  { group: 'english', question: 'What happens if I miss my appointment?', expect: [DOCS.policies] },
  { group: 'english', question: 'can I pay in installments', expect: [DOCS.policies, DOCS.pricing] },
  { group: 'english', question: 'are you accepting new patients', expect: [DOCS.faq] },
  { group: 'english', question: 'how much is a dental implant', expect: [DOCS.pricing] },
  { group: 'english', question: 'do you accept credit cards', expect: [DOCS.policies] },
  { group: 'english', question: 'Is there parking nearby?', expect: [DOCS.faq] },
  { group: 'english', question: 'cost of the first visit for a new patient', expect: [DOCS.pricing] },
  { group: 'english', question: 'how early do I need to cancel', expect: [DOCS.policies] },
  { group: 'english', question: 'is there a fee for cancelling late', expect: [DOCS.policies] },
  { group: 'english', question: 'do you offer free consultations for implants', expect: [DOCS.pricing] },
  { group: 'spanish', question: '¿Cuánto cuesta el blanqueamiento dental?', expect: [DOCS.spanishFaq, DOCS.pricing] },
  { group: 'spanish', question: '¿Aceptan pacientes nuevos?', expect: [DOCS.spanishFaq, DOCS.faq] },
  { group: 'spanish', question: '¿Cuál es su horario los sábados?', expect: [DOCS.spanishFaq, DOCS.faq] },
  { group: 'spanish', question: '¿Atienden a un paciente nuevo esta semana?', expect: [DOCS.spanishFaq, DOCS.faq] },
  { group: 'spanish', question: '¿Cuánto cuestan los tratamientos de blanqueamiento?', expect: [DOCS.spanishFaq, DOCS.pricing] },
  { group: 'hindi', question: 'दाँत सफेद करने की कीमत क्या है?', expect: [DOCS.hindiFaq, DOCS.pricing] },
  { group: 'hindi', question: 'क्लिनिक कब खुला है?', expect: [DOCS.hindiFaq, DOCS.faq] },
  { group: 'hindi', question: 'क्या आप नए मरीज़ों को देखते हैं?', expect: [DOCS.hindiFaq, DOCS.faq] },
  { group: 'hindi', question: 'सफेद दाँत का खर्च', expect: [DOCS.hindiFaq, DOCS.pricing] },
  { group: 'hinglish', question: 'invisalign ka price kya hai', expect: [DOCS.pricing] },
  { group: 'hinglish', question: 'clinic kab khula hai', expect: [DOCS.faq, DOCS.hindiFaq] },
  { group: 'hinglish', question: 'whitening kitne ka hai', expect: [DOCS.pricing, DOCS.hindiFaq] },
  { group: 'cross-language', question: '¿Qué pasa si cancelo tarde?', expect: [DOCS.policies] },
  { group: 'cross-language', question: '¿Tienen estacionamiento?', expect: [DOCS.faq] },
  { group: 'cross-language', question: 'इम्प्लांट की कीमत क्या है?', expect: [DOCS.pricing] },
];

export async function seedSearchSet(c: Container): Promise<{ orgId: string; knowledgeBaseIds: string[] }> {
  const { orgId } = await seedDemo(c);
  const scope = { orgId };
  const [demo] = await c.knowledge.listKnowledgeBases(scope);
  const spanish = await c.knowledge.createKnowledgeBase(scope, { name: 'Español', description: '', language: 'spanish' });
  const hindi = await c.knowledge.createKnowledgeBase(scope, { name: 'हिन्दी', description: '', language: 'hindi' });
  await c.knowledge.createFaqDocument(scope, spanish.id, {
    title: DOCS.spanishFaq,
    category: 'faq',
    faq: [
      { question: '¿Cuál es su horario?', answer: 'De lunes a viernes de 9 a 17 h; los sábados de 10 a 14 h con cita previa.' },
      { question: '¿Aceptan pacientes nuevos?', answer: 'Sí, recibimos pacientes nuevos de todas las edades. La primera visita incluye examen, limpieza y radiografías.' },
      { question: '¿Cuánto cuesta el blanqueamiento?', answer: 'El blanqueamiento en consultorio cuesta 450 dólares; el kit para casa, 300 dólares.' },
    ],
  });
  await c.knowledge.createFaqDocument(scope, hindi.id, {
    title: DOCS.hindiFaq,
    category: 'faq',
    faq: [
      { question: 'क्लिनिक कब खुला रहता है?', answer: 'सोमवार से शुक्रवार सुबह 9 बजे से शाम 5 बजे तक, और शनिवार को सुबह 10 बजे से दोपहर 2 बजे तक।' },
      { question: 'दाँत सफेद करने की कीमत क्या है?', answer: 'क्लिनिक में दाँत सफेद करने की कीमत 450 डॉलर है।' },
      { question: 'क्या आप नए मरीज़ देखते हैं?', answer: 'हाँ, हम सभी उम्र के नए मरीज़ों का स्वागत करते हैं।' },
    ],
  });
  await c.queue.drain();
  return { orgId, knowledgeBaseIds: [demo!.id, spanish.id, hindi.id] };
}

export interface GroupScore {
  questions: number;
  first: number;
  top5: number;
  /** Mean reciprocal rank of the first right document (0 when it isn't in the top 5). */
  mrr: number;
}

/** Runs every question and scores where the first right document lands. */
export async function evaluateSearch(c: Container, seeded: { orgId: string; knowledgeBaseIds: string[] }) {
  const scope = { orgId: seeded.orgId };
  const titles = new Map<string, string>();
  for (const kb of seeded.knowledgeBaseIds) for (const d of await c.knowledge.listDocuments(scope, kb)) titles.set(d.id, d.title);
  const scores = {} as Record<SearchGroup, GroupScore>;
  const misses: string[] = [];
  for (const item of SEARCH_SET) {
    const result = await c.knowledge.search(scope, { knowledgeBaseIds: seeded.knowledgeBaseIds, query: item.question, limit: 5 });
    const found = result.chunks.map((ch) => titles.get(ch.documentId) ?? '?');
    const rank = found.findIndex((t) => item.expect.includes(t)) + 1;
    const g = (scores[item.group] ??= { questions: 0, first: 0, top5: 0, mrr: 0 });
    g.questions++;
    if (rank === 1) g.first++;
    if (rank >= 1) {
      g.top5++;
      g.mrr += 1 / rank;
    }
    if (rank !== 1) misses.push(`[${item.group}] "${item.question}" → ${rank ? `rank ${rank}` : 'not in top 5'}; got ${found.slice(0, 3).join(' | ') || 'nothing'}`);
  }
  for (const g of Object.values(scores)) g.mrr = g.questions ? g.mrr / g.questions : 0;
  return { scores, misses };
}

export function formatScores(scores: Record<SearchGroup, GroupScore>): string {
  const rows = Object.entries(scores).map(
    ([group, g]) => `| ${group} | ${g.first} / ${g.questions} | ${g.top5} / ${g.questions} | ${g.mrr.toFixed(2)} |`,
  );
  return ['| Group | Right document first | In top 5 | MRR |', '|---|---|---|---|', ...rows].join('\n');
}
