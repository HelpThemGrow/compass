/**
 * Pluggable embedding + reranking backends. Port of app/embeddings.py.
 *
 * Default is `local`: ONNX CPU inference via transformers.js
 * (@xenova/transformers), the Node/JS equivalent of the Python app's
 * fastembed backend - same idea (BAAI/bge-small-en-v1.5, CPU-only, no API
 * credits spent indexing), different runtime.
 *
 * Backends degrade rather than crash: local -> hash. The hash backend is a
 * dependency-free feature-hashing vectoriser so the app stays usable even if
 * the ONNX model weights haven't downloaded yet.
 */
import crypto from "node:crypto";
import { pipeline, env } from "@xenova/transformers";
import { settings } from "./config";

const WORD_RE = /[a-z0-9]+/g;

function tokenize(text: string): string[] {
  return (text ?? "").toLowerCase().match(WORD_RE) ?? [];
}

export interface Embedder {
  name: string;
  dim: number;
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

function l2(vec: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// --------------------------------------------------------------------------
// Hash embedder - feature hashing over unigrams and bigrams. No downloads.
// --------------------------------------------------------------------------
class HashEmbedder implements Embedder {
  name = "hash";
  dim: number;

  constructor(dim = 512) {
    this.dim = dim;
  }

  private vector(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const tokens = tokenize(text);
    const grams = [...tokens];
    for (let i = 0; i < tokens.length - 1; i++) grams.push(`${tokens[i]}_${tokens[i + 1]}`);
    for (const gram of grams) {
      const digest = crypto.createHash("blake2b512").update(gram, "utf-8").digest();
      const idx = digest.readUInt32LE(0) % this.dim;
      const sign = digest[4] & 1 ? 1 : -1;
      vec[idx] += sign;
    }
    return l2(vec);
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vector(text);
  }
}

// --------------------------------------------------------------------------
// Local CPU ONNX embeddings via transformers.js.
// --------------------------------------------------------------------------
// BGE models are asymmetric: queries need an instruction prefix that
// passages do not. fastembed bakes this into `.query_embed()` on the Python
// side; here it is made explicit since transformers.js has no such
// query/passage distinction of its own.
const BGE_QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

class LocalEmbedder implements Embedder {
  name = "local";
  dim = 0;
  private modelName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractor: any = null;
  private ready: Promise<void>;

  constructor(modelName: string) {
    this.modelName = modelName;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    // Cache weights under data/ like the rest of this app's runtime state,
    // rather than the library's default (a hidden dir next to node_modules).
    env.cacheDir = `${settings.dataDir}/.transformers-cache`;
    this.extractor = await pipeline("feature-extraction", this.modelName, { quantized: true });
    const probe = await this.embedOne("dimension probe");
    this.dim = probe.length;
  }

  // Not gated on `this.ready` - `init()` calls this itself while that
  // promise is still pending, so waiting on it here would deadlock.
  private async embedOne(text: string): Promise<Float32Array> {
    const result = await this.extractor(text, { pooling: "mean", normalize: true });
    return Float32Array.from(result.data as Float32Array);
  }

  private async embedRaw(texts: string[]): Promise<Float32Array[]> {
    await this.ready;
    const out: Float32Array[] = [];
    for (const text of texts) out.push(await this.embedOne(text));
    return out;
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    return this.embedRaw(texts);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.embedRaw([`${BGE_QUERY_INSTRUCTION}${text}`]);
    return v;
  }
}

// --------------------------------------------------------------------------
// Hosted NVIDIA embeddings. `input_type` is asymmetric and mandatory.
// --------------------------------------------------------------------------
class NvidiaEmbedder implements Embedder {
  name = "nvidia";
  dim = 0;
  private modelName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private ready: Promise<void>;

  constructor(modelName: string) {
    this.modelName = modelName;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const { default: OpenAI } = await import("openai");
    this.client = new OpenAI({ baseURL: settings.nvidiaBaseUrl, apiKey: settings.nvidiaApiKey, timeout: 120_000, maxRetries: 1 });
    const [probe] = await this.call(["dimension probe"], "passage");
    this.dim = probe.length;
  }

  private async call(texts: string[], inputType: "passage" | "query"): Promise<number[][]> {
    const { ledger, limiter } = await import("./llm");
    ledger.check();
    await limiter.acquire();
    let ok = false;
    try {
      const resp = await this.client.embeddings.create({
        input: texts,
        model: this.modelName,
        encoding_format: "float",
        input_type: inputType,
        truncate: "END",
      } as never);
      ok = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return resp.data.map((d: any) => d.embedding as number[]);
    } finally {
      ledger.record(`embed:${inputType}`, ok);
    }
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    await this.ready;
    if (!texts.length) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      out.push(...(await this.call(texts.slice(i, i + 64), "passage")));
    }
    return out.map((v) => l2(Float32Array.from(v)));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    await this.ready;
    const [v] = await this.call([text], "query");
    return l2(Float32Array.from(v));
  }
}

let _embedder: Embedder | null = null;
let _embedderNote = "";
let _embedderPromise: Promise<Embedder> | null = null;

export async function getEmbedder(): Promise<Embedder> {
  if (_embedder) return _embedder;
  if (_embedderPromise) return _embedderPromise;

  _embedderPromise = (async () => {
    let backend = settings.embeddingBackend;

    if (backend === "nvidia" && settings.llmConfigured) {
      try {
        const emb = new NvidiaEmbedder(settings.nvidiaEmbeddingModel);
        await (emb as unknown as { ready: Promise<void> }).ready;
        _embedder = emb;
        _embedderNote = `NVIDIA ${settings.nvidiaEmbeddingModel}`;
        return emb;
      } catch (exc) {
        _embedderNote = `NVIDIA embeddings unavailable (${exc}); fell back to local.`;
        backend = "local";
      }
    }

    if (backend === "local") {
      try {
        const emb = new LocalEmbedder(settings.localEmbeddingModel);
        await (emb as unknown as { ready: Promise<void> }).ready;
        _embedder = emb;
        _embedderNote = `local CPU ${settings.localEmbeddingModel}`;
        return emb;
      } catch (exc) {
        _embedderNote = `transformers.js unavailable (${exc}); using the hash fallback.`;
      }
    }

    const emb = new HashEmbedder();
    _embedder = emb;
    _embedderNote = _embedderNote || "hash fallback";
    return emb;
  })();

  return _embedderPromise;
}

export async function embedderStatus() {
  const emb = await getEmbedder();
  return { backend: emb.name, dim: emb.dim, detail: _embedderNote };
}

// --------------------------------------------------------------------------
// Reranking
// --------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _reranker: any = null;
let _rerankerFailed = false;

async function getReranker() {
  if (_reranker || _rerankerFailed) return _reranker;
  try {
    _reranker = await pipeline("text-classification", settings.localRerankModel);
  } catch {
    _rerankerFailed = true;
  }
  return _reranker;
}

/** Cross-encoder scores, or null when reranking is off/unavailable. */
export async function rerank(query: string, docs: string[]): Promise<number[] | null> {
  if (!settings.rerankEnabled || !docs.length) return null;
  const model = await getReranker();
  if (!model) return null;
  try {
    const scores: number[] = [];
    for (const doc of docs) {
      const result = await model(`${query} [SEP] ${doc}`);
      scores.push(Array.isArray(result) ? Number(result[0]?.score ?? 0) : 0);
    }
    return scores;
  } catch {
    return null;
  }
}
