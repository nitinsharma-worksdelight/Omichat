import type { Section } from './extract';

export interface Chunk {
  title: string;
  content: string;
  tokenCount: number;
  heading?: string;
  page?: number;
  url?: string;
}

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { targetTokens: 450, maxTokens: 700, overlapTokens: 60 };

/** ~4 characters per token for English; close enough for sizing chunks and budgeting prompts. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface Block {
  heading: string;
  text: string;
}

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const headings: string[] = [];
  for (const para of text.split(/\n{2,}|\n(?=#{1,4} )/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const m = /^(#{1,4}) (.+)$/.exec(trimmed.split('\n')[0]!);
    if (m) {
      const level = m[1]!.length;
      headings.length = level - 1;
      headings[level - 1] = m[2]!.trim();
      const rest = trimmed.split('\n').slice(1).join('\n').trim();
      if (rest) blocks.push({ heading: headings.filter(Boolean).join(' › '), text: rest });
      continue;
    }
    blocks.push({ heading: headings.filter(Boolean).join(' › '), text: trimmed });
  }
  return blocks;
}

function splitLong(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [text];
  const parts: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (estimateTokens(buf + s) > maxTokens && buf) {
      parts.push(buf.trim());
      buf = '';
    }
    if (estimateTokens(s) > maxTokens) {
      // A single enormous "sentence" (tables, minified text): hard-split by characters.
      for (let i = 0; i < s.length; i += maxTokens * 4) parts.push(s.slice(i, i + maxTokens * 4).trim());
      continue;
    }
    buf += s;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function tail(text: string, tokens: number): string {
  const chars = tokens * 4;
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  const boundary = cut.search(/[.!?]\s|\n/);
  return (boundary >= 0 ? cut.slice(boundary + 1) : cut).trim();
}

/**
 * Heading-aware chunking: split into blocks at paragraphs/headings, pack blocks up to the target size
 * within the same heading, and carry a short overlap so a fact split across a boundary isn't lost.
 */
export function chunkSections(docTitle: string, sections: Section[], opts: ChunkOptions = DEFAULT_CHUNKING): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const blocks = toBlocks(section.text).flatMap((b) => splitLong(b.text, opts.maxTokens).map((text) => ({ ...b, text })));
    let current: { heading: string; parts: string[] } | null = null;
    const flush = () => {
      if (!current || !current.parts.length) return;
      const content = current.parts.join('\n\n').trim();
      const baseTitle = section.title && section.title !== docTitle ? `${docTitle} › ${section.title}` : docTitle;
      chunks.push({
        title: current.heading ? `${baseTitle} › ${current.heading}` : baseTitle,
        content,
        tokenCount: estimateTokens(content),
        heading: current.heading || undefined,
        page: section.page,
        url: section.url,
      });
    };
    for (const block of blocks) {
      const size = current ? estimateTokens(current.parts.join('\n\n')) : 0;
      const sameHeading = current?.heading === block.heading;
      if (!current || !sameHeading || size + estimateTokens(block.text) > opts.targetTokens) {
        const overlap: string = current && sameHeading ? tail(current.parts.join('\n\n'), opts.overlapTokens) : '';
        flush();
        current = { heading: block.heading, parts: overlap ? [overlap] : [] };
      }
      current.parts.push(block.text);
    }
    flush();
  }
  return chunks.filter((c) => c.content.length > 0);
}

export function chunkFaq(docTitle: string, pairs: Array<{ question: string; answer: string }>): Chunk[] {
  return pairs
    .filter((p) => p.question.trim() && p.answer.trim())
    .map((p) => {
      const content = `Q: ${p.question.trim()}\nA: ${p.answer.trim()}`;
      return { title: `${docTitle} › ${p.question.trim().slice(0, 120)}`, content, tokenCount: estimateTokens(content), heading: p.question.trim() };
    });
}
