/**
 * Hybrid retrieval store: dense vectors + BM25, fused with Reciprocal Rank
 * Fusion. Port of app/store.py.
 *
 * A brute-force in-memory scan rather than a vector database - a framework
 * library is thousands of chunks, not millions, so an exhaustive cosine scan
 * is sub-millisecond, has no server to run, and the whole index is two
 * inspectable JSON files on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { settings } from "./config";
import { getEmbedder, rerank } from "./embeddings";
import type { Chunk } from "./chunking";
import { citation } from "./chunking";

const WORD_RE = /[a-z0-9]+/g;
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "is",
  "are", "be", "as", "at", "by", "it", "this", "that", "from", "will", "shall",
  "should", "must", "we", "our", "their", "its", "has", "have", "been", "was",
]);

export function tokenize(text: string): string[] {
  return ((text ?? "").toLowerCase().match(WORD_RE) ?? []).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/** Okapi BM25. */
class BM25 {
  private k1 = 1.5;
  private b = 0.75;
  private docs: string[][];
  private docLen: number[];
  private avgLen: number;
  private postings = new Map<string, [number, number][]>();
  private idf = new Map<string, number>();
  n: number;

  constructor(corpus: string[]) {
    this.docs = corpus.map(tokenize);
    this.docLen = this.docs.map((d) => d.length || 1);
    this.avgLen = this.docLen.length ? this.docLen.reduce((a, b) => a + b, 0) / this.docLen.length : 1;
    this.n = this.docs.length;

    this.docs.forEach((doc, i) => {
      const counts = new Map<string, number>();
      for (const term of doc) counts.set(term, (counts.get(term) ?? 0) + 1);
      for (const [term, freq] of counts) {
        if (!this.postings.has(term)) this.postings.set(term, []);
        this.postings.get(term)!.push([i, freq]);
      }
    });

    for (const [term, plist] of this.postings) {
      this.idf.set(term, Math.log(1 + (this.n - plist.length + 0.5) / (plist.length + 0.5)));
    }
  }

  search(query: string, topK: number): [number, number][] {
    if (this.n === 0) return [];
    const scores = new Float64Array(this.n);
    const seen = new Set(tokenize(query));
    for (const term of seen) {
      const plist = this.postings.get(term);
      if (!plist) continue;
      const idf = this.idf.get(term)!;
      for (const [docId, freq] of plist) {
        const denom = freq + this.k1 * (1 - this.b + (this.b * this.docLen[docId]) / this.avgLen);
        scores[docId] += (idf * (freq * (this.k1 + 1))) / denom;
      }
    }
    const idx = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
    return idx.slice(0, topK).filter((i) => scores[i] > 0).map((i) => [i, scores[i]]);
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class VectorStore {
  name: string;
  chunks: Chunk[] = [];
  vectors: Float32Array[] = [];
  private bm25Index: BM25 | null = null;

  constructor(name: string) {
    this.name = name;
  }

  async build(chunks: Chunk[]): Promise<void> {
    this.chunks = chunks;
    const embedder = await getEmbedder();
    this.vectors = await embedder.embedPassages(chunks.map((c) => c.text));
    this.bm25Index = new BM25(chunks.map((c) => c.text));
  }

  async add(chunks: Chunk[]): Promise<void> {
    if (!chunks.length) return;
    const embedder = await getEmbedder();
    const newVectors = await embedder.embedPassages(chunks.map((c) => c.text));
    this.chunks.push(...chunks);
    this.vectors.push(...newVectors);
    this.bm25Index = new BM25(this.chunks.map((c) => c.text));
  }

  private bm25(): BM25 {
    if (!this.bm25Index) this.bm25Index = new BM25(this.chunks.map((c) => c.text));
    return this.bm25Index;
  }

  get length(): number {
    return this.chunks.length;
  }

  private paths(): [string, string] {
    return [
      path.join(settings.indexDir, `${this.name}.vectors.json`),
      path.join(settings.indexDir, `${this.name}.chunks.json`),
    ];
  }

  async save(): Promise<void> {
    const [vecPath, metaPath] = this.paths();
    fs.mkdirSync(path.dirname(vecPath), { recursive: true });
    const embedder = await getEmbedder();
    fs.writeFileSync(vecPath, JSON.stringify(this.vectors.map((v) => Array.from(v))));
    const payload = {
      embedding_backend: embedder.name,
      dim: this.vectors.length ? this.vectors[0].length : 0,
      chunks: this.chunks,
    };
    fs.writeFileSync(metaPath, JSON.stringify(payload), "utf-8");
  }

  async load(): Promise<boolean> {
    const [vecPath, metaPath] = this.paths();
    if (!fs.existsSync(vecPath) || !fs.existsSync(metaPath)) return false;
    try {
      const payload = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      this.chunks = payload.chunks as Chunk[];
      const raw = JSON.parse(fs.readFileSync(vecPath, "utf-8")) as number[][];
      this.vectors = raw.map((v) => Float32Array.from(v));

      const embedder = await getEmbedder();
      if (payload.embedding_backend !== embedder.name) return false;
      if (this.vectors.length && this.vectors[0].length !== embedder.dim) return false;
      if (this.vectors.length && this.vectors.length !== this.chunks.length) return false;
      this.bm25Index = null;
      return true;
    } catch {
      return false;
    }
  }

  clearDisk(): void {
    for (const p of this.paths()) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  }

  async search(
    query: string,
    opts: { topK?: number; rerankTo?: number; where?: Record<string, unknown> } = {}
  ): Promise<[Chunk, number][]> {
    if (!this.chunks.length) return [];
    const topK = opts.topK ?? settings.retrieveTopK;
    const pool = Math.max(topK * 3, 20);

    let allowed: Set<number> | null = null;
    if (opts.where) {
      allowed = new Set(
        this.chunks
          .map((c, i) => [i, c] as const)
          .filter(([, c]) =>
            Object.entries(opts.where!).every(
              ([k, v]) => c.meta?.[k] === v || (c as unknown as Record<string, unknown>)[k] === v
            )
          )
          .map(([i]) => i)
      );
      if (!allowed.size) return [];
    }

    let denseRanked: number[] = [];
    if (this.vectors.length) {
      const embedder = await getEmbedder();
      const qvec = await embedder.embedQuery(query);
      const sims = this.vectors.map((v, i) => (allowed && !allowed.has(i) ? -Infinity : dot(v, qvec)));
      const idx = sims.map((_, i) => i).sort((a, b) => sims[b] - sims[a]);
      denseRanked = idx.slice(0, pool).filter((i) => Number.isFinite(sims[i]));
    }

    const lexicalRanked = this.bm25()
      .search(query, pool)
      .map(([i]) => i)
      .filter((i) => !allowed || allowed.has(i));

    const k = 60;
    const fused = new Map<number, number>();
    denseRanked.forEach((idx, rank) => fused.set(idx, (fused.get(idx) ?? 0) + 1 / (k + rank + 1)));
    lexicalRanked.forEach((idx, rank) => fused.set(idx, (fused.get(idx) ?? 0) + 1 / (k + rank + 1)));

    const candidates = Array.from(fused.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, pool);
    if (!candidates.length) return [];

    const finalN = opts.rerankTo ?? topK;
    const candidateIds = candidates.map(([i]) => i);

    if (candidateIds.length > finalN) {
      const head = candidateIds.slice(0, settings.rerankMaxCandidates);
      const scores = await rerank(query, head.map((i) => this.chunks[i].text));
      if (scores) {
        const ordered = head
          .map((i, j) => [i, scores[j]] as const)
          .sort((a, b) => b[1] - a[1])
          .map(([i]) => i);
        const headSet = new Set(head);
        const tail = candidateIds.filter((i) => !headSet.has(i));
        const ranked = [...ordered, ...tail];
        return ranked.slice(0, finalN).map((i) => [this.chunks[i], fused.get(i) ?? 0]);
      }
    }

    return candidates.slice(0, finalN).map(([i, s]) => [this.chunks[i], s]);
  }
}

/** Render retrieved chunks as a numbered, citable context block. */
export function formatContext(hits: [Chunk, number][], maxTokens = 6000): string {
  const lines: string[] = [];
  let used = 0;
  let n = 0;
  for (const [chunk] of hits) {
    n += 1;
    const block = `[${n}] Source: ${citation(chunk)}\n${chunk.text}`;
    const cost = Math.floor(block.length / 4);
    if (used + cost > maxTokens) break;
    lines.push(block);
    used += cost;
  }
  return lines.join("\n\n---\n\n");
}
