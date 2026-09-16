/**
 * NVIDIA NIM client. Direct port of app/llm.py.
 *
 * NVIDIA's hosted endpoint is OpenAI-compatible but has three traits that
 * shape this module:
 *
 * - Ordinary chat/embedding calls on the free hosted endpoint do not draw
 *   down the signup credit pool. The constraint that actually binds is
 *   throughput, capped around 40 requests/minute account-wide, so a token
 *   bucket paces outbound calls rather than letting a burst 429. Every call
 *   is still recorded in an on-disk ledger for visibility.
 * - Structured output is done by putting the JSON Schema in the prompt and
 *   parsing tolerantly, not by constrained decoding - the hosted endpoint
 *   rejects `nvext.guided_json` outright (it is a self-hosted NIM feature).
 * - Reasoning-tuned models emit chain-of-thought by default;
 *   `chat_template_kwargs: {"thinking": false}` turns that off where
 *   supported and is dropped automatically where it is not.
 */
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { settings } from "./config";

export class LLMUnavailable extends Error {}
export class BudgetExhausted extends Error {}
/** The key authenticates but is not entitled to run inference. */
export class AccessDenied extends Error {}

// --------------------------------------------------------------------------
// Credit ledger
// --------------------------------------------------------------------------
interface LedgerState {
  calls: number;
  failed_calls: number;
  by_purpose: Record<string, number>;
  first_call: string | null;
  last_call: string | null;
}

class CreditLedger {
  private path: string;
  private budget: number;
  private state: LedgerState;

  constructor(ledgerPath = settings.ledgerPath, budget = settings.creditBudget) {
    this.path = ledgerPath;
    this.budget = budget;
    this.state = this.load();
  }

  private load(): LedgerState {
    try {
      if (fs.existsSync(this.path)) {
        return JSON.parse(fs.readFileSync(this.path, "utf-8"));
      }
    } catch {
      /* fall through to a fresh ledger */
    }
    return { calls: 0, failed_calls: 0, by_purpose: {}, first_call: null, last_call: null };
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(this.state, null, 2), "utf-8");
  }

  remaining(): number {
    return Math.max(0, this.budget - this.state.calls);
  }

  check(): void {
    if (this.remaining() <= 0) {
      throw new BudgetExhausted(
        `Local credit budget of ${this.budget} calls is spent. Raise CREDIT_BUDGET in ` +
          ".env.local once you have confirmed your real NVIDIA allowance, or reset " +
          "data/credit_ledger.json."
      );
    }
  }

  record(purpose: string, ok: boolean): void {
    this.state.calls += 1;
    if (!ok) this.state.failed_calls += 1;
    this.state.by_purpose[purpose] = (this.state.by_purpose[purpose] ?? 0) + 1;
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    this.state.first_call = this.state.first_call ?? now;
    this.state.last_call = now;
    this.flush();
  }

  snapshot() {
    return { ...this.state, budget: this.budget, remaining: this.remaining() };
  }
}

export const ledger = new CreditLedger();

// --------------------------------------------------------------------------
// Rate limiting - a token bucket over a rolling 60s window, shared process-wide.
// --------------------------------------------------------------------------
class RateLimiter {
  private perMinute: number;
  private hits: number[] = [];

  constructor(perMinute: number) {
    this.perMinute = Math.max(1, perMinute);
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.hits.length && now - this.hits[0] > 60_000) this.hits.shift();
      if (this.hits.length < this.perMinute) {
        this.hits.push(now);
        return;
      }
      const sleepFor = 60_000 - (now - this.hits[0]) + 50;
      await new Promise((r) => setTimeout(r, Math.max(50, sleepFor)));
    }
  }
}

export const limiter = new RateLimiter(settings.rpmLimit);

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------
export class CallStats {
  calls = 0;
  purposes: string[] = [];
  add(purpose: string) {
    this.calls += 1;
    this.purposes.push(purpose);
  }
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  if (!settings.llmConfigured) {
    throw new LLMUnavailable(
      "NVIDIA_API_KEY is not set. Copy .env.local.example to .env.local and add a " +
        "free key from https://build.nvidia.com"
    );
  }
  _client = new OpenAI({
    baseURL: settings.nvidiaBaseUrl,
    apiKey: settings.nvidiaApiKey,
    timeout: settings.llmTimeoutMs,
    maxRetries: 0, // retries are handled here so the ledger stays accurate
  });
  return _client;
}

function errText(exc: unknown): string {
  const e = exc as { message?: string; status?: number };
  return `${e?.status ?? ""} ${e?.message ?? String(exc)}`.toLowerCase();
}

function isRetryable(exc: unknown): boolean {
  const text = errText(exc);
  return ["429", "rate limit", "timeout", "502", "503", "504", "overloaded", "connection"].some((s) =>
    text.includes(s)
  );
}

function isBadModel(exc: unknown): boolean {
  const text = errText(exc);
  return (
    text.includes("404") ||
    text.includes("410") ||
    text.includes("end of life") ||
    text.includes("does not exist") ||
    (text.includes("model") && text.includes("not found"))
  );
}

function isAccessDenied(exc: unknown): boolean {
  const text = errText(exc);
  return text.includes("403") || text.includes("401") || text.includes("authorization failed") || text.includes("unauthorized");
}

function isUnknownField(exc: unknown): boolean {
  const text = errText(exc);
  return text.includes("unknown field") || text.includes("unrecognized") || text.includes("extra fields");
}

const ACCESS_DENIED_HELP =
  "NVIDIA rejected the request with 'Authorization failed'. The key authenticates " +
  "against /v1/models (the catalogue is readable) but every inference call is refused, " +
  "which usually means one of:\n" +
  "  1. A doubled key prefix - a real key (which already starts with \"nvapi-\") pasted " +
  'after a template\'s "nvapi-" placeholder. This app strips that automatically.\n' +
  "  2. The key is an NGC or org-scoped key rather than a personal API key generated " +
  "from a model page on build.nvidia.com.\n" +
  "  3. The NVIDIA Developer Program signup was not completed or its terms not accepted.\n" +
  "Structural checks, retrieval and the knowledge base all keep working without it.";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
function stripReasoning(text: string): string {
  return text.replace(THINK_RE, "").trim();
}

export async function chat(
  messages: ChatMessage[],
  opts: {
    purpose?: string;
    temperature?: number;
    maxTokens?: number;
    stats?: CallStats;
    attempts?: number;
  } = {}
): Promise<string> {
  const { purpose = "general", temperature = 0.1, maxTokens = 2048, stats, attempts = 3 } = opts;
  const client = getClient();
  ledger.check();

  let extras: Record<string, unknown> = settings.disableThinking
    ? { chat_template_kwargs: { thinking: false } }
    : {};

  const models = [settings.model];
  if (settings.modelFallback && settings.modelFallback !== settings.model) {
    models.push(settings.modelFallback);
  }

  const errors: string[] = [];

  for (const model of models) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await limiter.acquire();
      let ok = false;
      try {
        const resp = await client.chat.completions.create({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...extras,
        } as Parameters<typeof client.chat.completions.create>[0]);
        ok = true;
        stats?.add(purpose);
        const content = (resp as { choices: { message: { content: string | null } }[] }).choices[0]?.message
          ?.content ?? "";
        return stripReasoning(content);
      } catch (exc) {
        if (isAccessDenied(exc)) {
          ledger.record(purpose, ok);
          throw new AccessDenied(ACCESS_DENIED_HELP);
        }
        if (Object.keys(extras).length && isUnknownField(exc)) {
          extras = {};
          ledger.record(purpose, ok);
          continue;
        }
        errors.push(`${model}: ${String((exc as Error)?.message ?? exc).slice(0, 200)}`);
        ledger.record(purpose, ok);
        if (isBadModel(exc)) break; // retired or unknown - the fallback model may work
        if (!isRetryable(exc) || attempt === attempts - 1) break;
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
    }
  }

  const detail = Array.from(new Set(errors)).join(" | ") || "no models configured";
  throw new Error(
    `Every configured model failed for '${purpose}'. ${detail}. Set NVIDIA_MODEL in ` +
      ".env.local to a model your key can reach."
  );
}

// --------------------------------------------------------------------------
// JSON handling
// --------------------------------------------------------------------------
export function extractJson(text: string): unknown {
  text = (text ?? "").trim();
  if (!text) throw new Error("Model returned an empty response.");

  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }

  for (const [opener, closer] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = text.indexOf(opener);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === opener) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`Could not parse JSON from model output: ${text.slice(0, 400)}`);
}

function withSchema(messages: ChatMessage[], jsonSchema: object): ChatMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const instruction = `Return a single JSON object and nothing else - no prose before or after it, no markdown code fence. It must match this JSON Schema exactly:\n${JSON.stringify(jsonSchema)}`;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      out[i] = { ...out[i], content: `${out[i].content}\n\n${instruction}` };
      return out;
    }
  }
  out.push({ role: "user", content: instruction });
  return out;
}

export async function chatJson(
  messages: ChatMessage[],
  opts: {
    jsonSchema: object;
    purpose?: string;
    temperature?: number;
    maxTokens?: number;
    stats?: CallStats;
  }
): Promise<unknown> {
  const { jsonSchema, purpose = "general", temperature = 0.1, maxTokens = 3072, stats } = opts;
  const raw = await chat(withSchema(messages, jsonSchema), { purpose, temperature, maxTokens, stats });
  try {
    return extractJson(raw);
  } catch {
    const repair: ChatMessage[] = [
      {
        role: "system",
        content: "You convert malformed text into valid JSON matching a schema. Reply with JSON only.",
      },
      {
        role: "user",
        content: `Schema:\n${JSON.stringify(jsonSchema)}\n\nMalformed output:\n${raw.slice(0, 6000)}\n\nReturn only the corrected JSON.`,
      },
    ];
    const fixed = await chat(repair, { purpose: `${purpose}:repair`, temperature: 0.0, maxTokens, stats });
    return extractJson(fixed);
  }
}

export function health() {
  return {
    configured: settings.llmConfigured,
    model: settings.model,
    fallback: settings.modelFallback,
    base_url: settings.nvidiaBaseUrl,
    ledger: ledger.snapshot(),
  };
}
