/**
 * Layer 2: grounded question answering over the framework library. Port of
 * app/qa.py.
 *
 * Deliberately restrictive: if the retrieved framework extracts do not
 * contain the answer, the model must say so rather than fill the gap from
 * general knowledge.
 */
import { settings } from "./config";
import * as llm from "./llm";
import * as ingest from "./ingest";
import { formatContext } from "./store";
import { citation, type Chunk } from "./chunking";

const QA_SYSTEM = `You answer questions about a non-profit's internal operating framework, using only the framework extracts provided.

Rules:
1. Answer only from the EXTRACTS. If they do not contain the answer, say exactly what is missing and suggest which framework document would hold it. Never fall back on general knowledge about NGOs or grant-making.
2. Cite the extract number inline as [1], [2] after each claim that relies on it.
3. Quote the framework's own wording for anything that is a rule, threshold, or mandatory requirement.
4. Be concise and practical. Programme staff are asking so they can act.
5. If the extracts conflict with each other, say so and cite both.
6. Never invent document names, section numbers, thresholds or dates.`;

const MAX_HISTORY_TURNS = 6;

export interface QaSource {
  n: number;
  citation: string;
  path: string;
  heading: string;
  score: number;
  excerpt: string;
}

function sources(hits: [Chunk, number][]): QaSource[] {
  return hits.map(([chunk, score], i) => ({
    n: i + 1,
    citation: citation(chunk),
    path: (chunk.meta?.path as string) ?? chunk.source,
    heading: chunk.heading,
    score: Math.round(score * 10000) / 10000,
    excerpt: chunk.text.slice(0, 500),
  }));
}

export async function answer(
  question: string,
  opts: { history?: { role: string; content: string }[]; topK?: number } = {}
): Promise<{ answer: string; sources: QaSource[]; api_calls: number }> {
  const store = await ingest.getStore();
  if (!store.length) {
    return {
      answer:
        "The framework library is empty. Add the framework documents and standard templates to the `frameworks/` folder, then press Rebuild Index.",
      sources: [],
      api_calls: 0,
    };
  }

  let searchQuery = question;
  const history = opts.history ?? [];
  if (history.length) {
    const previous = history.filter((m) => m.role === "user").map((m) => m.content);
    if (previous.length && question.split(/\s+/).length <= 8) {
      searchQuery = `${previous[previous.length - 1]} ${question}`;
    }
  }

  const hits = await store.search(searchQuery, { topK: opts.topK ?? 8 });
  const context = formatContext(hits, 6500);

  if (!settings.llmConfigured) {
    return {
      answer: "No NVIDIA API key is configured, so I cannot compose an answer. The most relevant framework passages are listed below.",
      sources: sources(hits),
      api_calls: 0,
    };
  }

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: QA_SYSTEM }];
  for (const turn of history.slice(-MAX_HISTORY_TURNS * 2)) {
    if ((turn.role === "user" || turn.role === "assistant") && turn.content) {
      messages.push({ role: turn.role, content: String(turn.content).slice(0, 4000) });
    }
  }
  messages.push({ role: "user", content: `## FRAMEWORK EXTRACTS\n${context}\n\n## QUESTION\n${question}` });

  const stats = new llm.CallStats();
  try {
    const text = await llm.chat(messages, { purpose: "qa", temperature: 0.15, maxTokens: 1400, stats });
    return { answer: text, sources: sources(hits), api_calls: stats.calls };
  } catch (exc) {
    if (exc instanceof llm.BudgetExhausted || exc instanceof llm.AccessDenied) {
      return { answer: (exc as Error).message, sources: sources(hits), api_calls: 0 };
    }
    return {
      answer: `The model call failed: ${(exc as Error).message}\n\nThe retrieved passages are listed below.`,
      sources: sources(hits),
      api_calls: stats.calls,
    };
  }
}
