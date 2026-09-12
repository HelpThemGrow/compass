/**
 * Central configuration. Everything is env-overridable so nothing is
 * hard-coded. Direct TypeScript port of app/config.py - same variable names,
 * same defaults, same directory layout, so a working `.env` from the Python
 * app maps onto `.env.local` here field for field.
 */
import path from "node:path";

const ROOT = process.cwd();

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

/**
 * Undo the one paste mistake this key format invites: pasting a real
 * "nvapi-..." key after a template's "nvapi-" placeholder produces
 * "nvapi-nvapi-...", which authenticates against /v1/models fine but fails
 * every inference call with a 403 that looks exactly like an entitlement
 * problem. Same fix as Settings._clean_api_key in the Python app.
 */
function cleanApiKey(raw: string): string {
  const key = (raw ?? "").trim();
  if (key.startsWith("nvapi-nvapi-")) return key.slice("nvapi-".length);
  return key;
}

export const settings = {
  // --- paths --------------------------------------------------------------
  root: ROOT,
  frameworksDir: path.join(ROOT, "frameworks"),
  rubricsDir: path.join(ROOT, "rubrics"),
  generationDir: path.join(ROOT, "generation"),
  docTemplatesDir: path.join(ROOT, "doc_templates"),
  dataDir: path.join(ROOT, "data"),
  indexDir: path.join(ROOT, "data", "index"),
  uploadsDir: path.join(ROOT, "data", "uploads"),
  reportsDir: path.join(ROOT, "data", "reports"),
  generatedDir: path.join(ROOT, "data", "generated"),
  ledgerPath: path.join(ROOT, "data", "credit_ledger.json"),

  // --- LLM ------------------------------------------------------------------
  nvidiaApiKey: cleanApiKey(process.env.NVIDIA_API_KEY ?? ""),
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
  model: process.env.NVIDIA_MODEL || "nvidia/nemotron-3-super-120b-a12b",
  modelFallback: process.env.NVIDIA_MODEL_FALLBACK || "openai/gpt-oss-120b",

  rpmLimit: int("NVIDIA_RPM_LIMIT", 35),
  // Confirmed against a real account: NVIDIA's free hosted endpoint does not
  // deduct ordinary chat/embedding calls from the signup credit pool. The
  // constraint that actually binds is the request-rate limit above, not a
  // lifetime call count. Kept as a large, loose safety valve.
  creditBudget: int("CREDIT_BUDGET", 200_000),
  maxCallsPerEvaluation: int("MAX_CALLS_PER_EVALUATION", 20),
  llmTimeoutMs: int("LLM_TIMEOUT_S", 180) * 1000,
  // Suppresses chain-of-thought on reasoning-tuned models. Silently ignored
  // by models that do not support the switch.
  disableThinking: bool("DISABLE_THINKING", true),

  // --- embeddings -----------------------------------------------------------
  embeddingBackend: (process.env.EMBEDDING_BACKEND || "local").trim().toLowerCase(),
  // Xenova/bge-small-en-v1.5 is the transformers.js (ONNX, CPU) port of the
  // same BAAI/bge-small-en-v1.5 model the Python app runs via fastembed -
  // same vectors' spirit, same dimensionality, no Python/torch involved.
  localEmbeddingModel: process.env.LOCAL_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5",
  nvidiaEmbeddingModel: process.env.NVIDIA_EMBEDDING_MODEL || "nvidia/nemotron-3-embed-1b",

  rerankEnabled: bool("RERANK_ENABLED", false),
  rerankMaxCandidates: int("RERANK_MAX_CANDIDATES", 12),
  localRerankModel: process.env.LOCAL_RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2",

  // --- retrieval --------------------------------------------------------------
  chunkTargetTokens: int("CHUNK_TARGET_TOKENS", 450),
  chunkOverlapTokens: int("CHUNK_OVERLAP_TOKENS", 60),
  retrieveTopK: int("RETRIEVE_TOP_K", 8),
  rerankTopN: int("RERANK_TOP_N", 4),

  // Score bands used across the report + UI. Ordered high to low.
  bands: [
    [85, "Board Ready", "Meets the framework. Minor polish only."],
    [70, "Minor Revisions", "Sound proposal with specific fixable gaps."],
    [55, "Major Revisions", "Core framework requirements are unevidenced."],
    [0, "Not Ready", "Needs redevelopment against the framework before review."],
  ] as [number, string, string][],

  get llmConfigured(): boolean {
    return Boolean(this.nvidiaApiKey) && !this.nvidiaApiKey.endsWith("REPLACE_ME");
  },

  bandFor(score: number): [string, string] {
    for (const [threshold, label, note] of this.bands) {
      if (score >= threshold) return [label, note];
    }
    const last = this.bands[this.bands.length - 1];
    return [last[1], last[2]];
  },
};
