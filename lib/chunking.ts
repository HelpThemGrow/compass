/**
 * Structure-aware chunking. Port of app/chunking.py.
 *
 * Splits on the document's own heading boundaries first, then packs
 * paragraphs up to a token target with overlap. Keeping the owning heading
 * on every chunk means a retrieved snippet can always be cited as "under
 * Section 3.2, Budget".
 */
import { settings } from "./config";
import type { ExtractedDoc } from "./extract";

export interface Chunk {
  text: string;
  heading: string;
  order: number;
  start: number;
  doc_id: string;
  source: string;
  meta: Record<string, unknown>;
}

export function citation(c: Chunk): string {
  return c.heading ? `${c.source} — ${c.heading}` : c.source;
}

/** Cheap token estimate. Avoids a tokenizer dependency; ~4 chars per token. */
export function approxTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

const SPLIT_LONG = /(?<=[.!?])\s+/;

function splitOversized(text: string, limit: number): string[] {
  if (approxTokens(text) <= limit) return [text];
  const sentences = text.split(SPLIT_LONG);
  const out: string[] = [];
  let buf = "";
  for (const sentence of sentences) {
    const candidate = `${buf} ${sentence}`.trim();
    if (buf && approxTokens(candidate) > limit) {
      out.push(buf);
      buf = sentence;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);

  const final: string[] = [];
  for (let piece of out) {
    while (approxTokens(piece) > limit * 1.5) {
      const cut = limit * 4;
      final.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    if (piece.trim()) final.push(piece);
  }
  return final;
}

export function chunkDocument(
  doc: ExtractedDoc,
  opts: { docId: string; targetTokens?: number; overlapTokens?: number }
): Chunk[] {
  const target = opts.targetTokens ?? settings.chunkTargetTokens;
  const overlap = opts.overlapTokens ?? settings.chunkOverlapTokens;

  const text = doc.text;
  if (!text.trim()) return [];

  const boundaries: [number, string][] = doc.headings.map((h) => [h.offset, h.text]);
  if (!boundaries.length || boundaries[0][0] > 0) boundaries.unshift([0, ""]);

  const sections: [string, string][] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const [start, heading] = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1][0] : text.length;
    const body = text.slice(start, end).trim();
    if (body) sections.push([heading, body]);
  }

  const chunks: Chunk[] = [];
  let order = 0;
  let cursor = 0;

  for (const [heading, body] of sections) {
    let sectionStart = text.indexOf(body, cursor);
    if (sectionStart === -1) sectionStart = cursor;
    cursor = sectionStart + body.length;

    const paragraphs: string[] = [];
    for (const para of body.split(/\n\s*\n/)) {
      const p = para.trim();
      if (p) paragraphs.push(...splitOversized(p, target));
    }

    let buf: string[] = [];
    let bufTokens = 0;
    let offsetInSection = 0;
    let chunkStart = 0;

    const flush = (buffer: string[], startOffset: number) => {
      const bodyText = buffer.join("\n\n").trim();
      if (!bodyText) return;
      const payload = heading ? `${heading}\n\n${bodyText}` : bodyText;
      chunks.push({
        text: payload,
        heading,
        order,
        start: sectionStart + startOffset,
        doc_id: opts.docId,
        source: doc.source,
        meta: {},
      });
      order += 1;
    };

    for (const para of paragraphs) {
      const paraTokens = approxTokens(para);
      if (buf.length && bufTokens + paraTokens > target) {
        flush(buf, chunkStart);
        const carry: string[] = [];
        let carried = 0;
        for (let i = buf.length - 1; i >= 0; i--) {
          const prevTokens = approxTokens(buf[i]);
          if (carried + prevTokens > overlap) break;
          carry.unshift(buf[i]);
          carried += prevTokens;
        }
        buf = [...carry, para];
        bufTokens = carried + paraTokens;
        chunkStart = offsetInSection;
      } else {
        buf.push(para);
        bufTokens += paraTokens;
      }
      offsetInSection += para.length + 2;
    }

    flush(buf, chunkStart);
  }

  return chunks;
}
