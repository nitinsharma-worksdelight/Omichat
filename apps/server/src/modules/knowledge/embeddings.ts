import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS } from '../../db/schema/_helpers';
import { sleep } from '../../lib/async';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** Cosine similarity at or above which a chunk counts as clearly relevant for this model. */
  readonly relevanceThreshold: number;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

/** OpenAI embeddings over REST (text-embedding-3-small → 1536 dims). */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly relevanceThreshold = 0.35;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 96) {
      out.push(...(await this.batch(texts.slice(i, i + 96))));
    }
    return out;
  }

  private async batch(input: string[], attempt = 1): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input, dimensions: this.dimensions }),
      signal: AbortSignal.timeout(60_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return this.batch(input, attempt + 1);
    }
    if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export const STOP = new Set(
  'a an and are as at be but by can do does for from has have how i if in is it its me my of on or our so that the their them there these they this to was we what when where which who why will with you your'.split(
    ' ',
  ),
);

/**
 * Words in any script, lowercased. Combining marks (\p{M}) stay in the word: Hindi, Tamil and other Indic
 * scripts write vowels as marks, so splitting on them breaks every word apart.
 */
export function words(text: string): string[] {
  return (text.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && /[\p{L}\p{N}]/u.test(w));
}

export function lexicalTokens(text: string): string[] {
  return words(text)
    .filter((t) => !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

/**
 * Keyless development embedder: hashed bag of words + bigrams, L2-normalized. Similarity reflects
 * word overlap rather than meaning, which is enough to exercise the pipeline locally and in tests.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  /** v2: words keep their combining marks. A new name makes existing documents re-embed on startup. */
  readonly model = 'local-hash-v2';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly relevanceThreshold = 0.2;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const tokens = lexicalTokens(text);
    const features = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
    for (const f of features) {
      const h = createHash('md5').update(f).digest();
      const idx = h.readUInt32LE(0) % this.dimensions;
      v[idx]! += h[4]! & 1 ? 1 : -1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
