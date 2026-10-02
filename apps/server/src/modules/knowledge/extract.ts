import { load, type CheerioAPI } from 'cheerio';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { badRequest } from '../../lib/errors';
import { assertSafeUrl, fetchLimited } from '../../lib/net';

/** A run of text from one source location. Chunks never cross sections, so citations stay precise. */
export interface Section {
  text: string;
  page?: number;
  url?: string;
  title?: string;
}

export const SUPPORTED_UPLOAD_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
};

export function detectFileKind(mimeType: string, filename: string): 'pdf' | 'docx' | 'txt' | 'md' | 'csv' | 'html' | null {
  const byMime = SUPPORTED_UPLOAD_TYPES[mimeType.split(';')[0]!.trim().toLowerCase()];
  if (byMime) return byMime as never;
  const ext = filename.toLowerCase().split('.').pop();
  return ext && ['pdf', 'docx', 'txt', 'md', 'csv', 'html', 'htm'].includes(ext) ? ((ext === 'htm' ? 'html' : ext) as never) : null;
}

export async function extractFromFile(buffer: Buffer, mimeType: string, filename: string): Promise<Section[]> {
  const kind = detectFileKind(mimeType, filename);
  switch (kind) {
    case 'pdf': {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: false });
      return text.map((t, i) => ({ text: cleanText(t), page: i + 1 })).filter((s) => s.text);
    }
    case 'docx': {
      const { value } = await mammoth.convertToHtml({ buffer });
      return [{ text: htmlToText(load(value)) }];
    }
    case 'html':
      return [{ text: htmlToText(load(buffer.toString('utf8'))) }];
    case 'txt':
    case 'md':
    case 'csv':
      return [{ text: cleanText(buffer.toString('utf8')) }];
    default:
      throw badRequest(`Unsupported file type: ${mimeType || filename}. Upload PDF, DOCX, TXT, MD, CSV or HTML.`);
  }
}

export interface UrlExtractOptions {
  crawl: boolean;
  maxPages: number;
  allowPrivate: boolean;
}

/** Fetches one page, or crawls same-site pages under the start URL's path (breadth-first). */
export async function extractFromUrl(startUrl: string, opts: UrlExtractOptions): Promise<{ title: string; sections: Section[] }> {
  const start = await assertSafeUrl(startUrl, { allowPrivate: opts.allowPrivate });
  const queue: string[] = [normalizeUrl(start)];
  const seen = new Set(queue);
  const sections: Section[] = [];
  let title = start.hostname;
  const limit = opts.crawl ? Math.min(opts.maxPages, 50) : 1;

  while (queue.length && sections.length < limit) {
    const pageUrl = queue.shift()!;
    let page;
    try {
      page = await fetchLimited(pageUrl, {
        timeoutMs: 15_000,
        maxBytes: 5_000_000,
        allowPrivate: opts.allowPrivate,
      });
    } catch (err) {
      if (pageUrl === queue[0] || sections.length === 0) throw err;
      continue;
    }
    if (page.status >= 400) {
      if (sections.length === 0 && !queue.length) throw badRequest(`${pageUrl} returned HTTP ${page.status}`);
      continue;
    }
    if (page.contentType.includes('application/pdf')) {
      for (const s of await extractFromFile(page.body, 'application/pdf', 'page.pdf')) sections.push({ ...s, url: page.finalUrl });
      continue;
    }
    if (!page.contentType.includes('html') && !page.contentType.includes('text/plain')) continue;
    const $ = load(page.body.toString('utf8'));
    const pageTitle = ($('meta[property="og:title"]').attr('content') ?? $('title').first().text()).trim();
    if (sections.length === 0 && pageTitle) title = pageTitle;
    if (opts.crawl) {
      for (const href of $('a[href]').map((_, a) => $(a).attr('href')).get()) {
        const next = resolveLink(href, page.finalUrl, start);
        if (next && !seen.has(next) && seen.size < limit * 4) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const text = htmlToText($);
    if (text.length > 40) sections.push({ text, url: page.finalUrl, title: pageTitle || undefined });
  }
  if (!sections.length) throw badRequest(`No readable text found at ${startUrl}`);
  return { title, sections };
}

function normalizeUrl(u: URL): string {
  const copy = new URL(u.toString());
  copy.hash = '';
  return copy.toString();
}

function resolveLink(href: string, base: string, start: URL): string | null {
  try {
    const u = new URL(href, base);
    if (u.origin !== start.origin) return null;
    const scope = start.pathname.endsWith('/') ? start.pathname : start.pathname.replace(/[^/]*$/, '');
    if (!u.pathname.startsWith(scope)) return null;
    if (/\.(png|jpe?g|gif|svg|webp|css|js|zip|mp4|mp3|ico|woff2?)$/i.test(u.pathname)) return null;
    return normalizeUrl(u);
  } catch {
    return null;
  }
}

/** Readable text with headings kept as markdown `#` lines, so the chunker can split on them. */
export function htmlToText($: CheerioAPI): string {
  $('script, style, noscript, svg, iframe, form, nav, footer, header, aside, [aria-hidden="true"]').remove();
  const root = $('main').first().length ? $('main').first() : $('article').first().length ? $('article').first() : $('body');
  const lines: string[] = [];
  root.find('h1, h2, h3, h4, p, li, td, th, blockquote, pre, dt, dd').each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const text = $(el).clone().children('ul, ol').remove().end().text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (/^h[1-4]$/.test(tag)) lines.push(`\n${'#'.repeat(Number(tag[1]))} ${text}\n`);
    else if (tag === 'li') lines.push(`- ${text}`);
    else lines.push(text);
  });
  const out = lines.length ? lines.join('\n') : root.text();
  return cleanText(out);
}

export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
