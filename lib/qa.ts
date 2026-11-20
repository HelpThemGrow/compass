/**
 * Layer 2: grounded question answering over the knowledge base. Port of
 * app/qa.py, with document-aware context assembly.
 *
 * Deliberately restrictive: if the documents supplied do not contain the
 * answer, the model must say so rather than fill the gap from general
 * knowledge.
 *
 * Context is assembled per document, not per passage. Passage-level top-k
 * retrieval fragments a policy: a question like "what must a partner provide
 * for due diligence?" matches the policy's title and conclusion strongly but
 * each numbered requirement section only weakly, so the sections that
 * actually hold the answer never reach the model. Instead, retrieved passages
 * vote for the documents they belong to, and the best documents are given to
 * the model whole - headings and all - so it can answer from the complete
 * rule set. The knowledge base is a few tens of thousands of tokens, well
 * inside the model's context window, so this costs little.
 */
import { settings } from "./config";
import * as llm from "./llm";
import * as ingest from "./ingest";
import { citation, type Chunk } from "./chunking";

const QA_SYSTEM = `You are the knowledge assistant for Vibha, an education non-profit. You answer staff questions using only the Vibha framework documents supplied with each question - policies, standards, SOPs and templates.

Grounding rules (never break these):
1. Answer only from the DOCUMENTS provided. Never add requirements, numbers, document names, section numbers or deadlines that are not in them, and never fall back on general knowledge about NGOs, law or grant-making.
2. If the documents only partly answer the question, answer the part they cover and say plainly what is not covered.
3. Keep every number, threshold, percentage, time limit and mandatory wording exactly as the document states it - including qualifiers such as "typically", "expected", "where applicable" and "unless". Never harden guidance into an absolute rule, and never add "always"/"never" that the document does not say.
4. Cite a section number only when that section heading appears in the document you are citing. Otherwise cite the document number alone.
5. If two documents conflict, say so and cite both.

How to answer:
- Be complete. When the question asks what is required, what must be provided, what a process involves, or what something must contain, give the full set from the relevant document, organised the way the document organises it (by its own sections). Do not stop at the first passage that matches.
- For a focused question about one rule or threshold, lead with the direct answer, then include the conditions, exceptions and definitions that the documents state alongside that same rule.
- Check every supplied document for rules on the same subject - a governing policy is often supplemented by another (for example, a data protection policy and a safeguarding policy both governing children's data, or a funding policy and a financial policy both governing overhead).
- Answer the question actually asked. Add material from another document only when it applies to the same process and stage the question is about (for example, safeguarding items that a policy says are checked at due diligence). Do not present obligations that apply at a different stage - such as during or after a grant - as part of the answer. If something closely related is genuinely useful, put it in a short final "Related" note and label it as such.
- Keep straight who is responsible for what: what the partner or programme team must provide, versus what Vibha, MEAL or a committee checks, records or decides.
- Never pad with generic text, and never repeat yourself.
- Cite the source number in square brackets after each claim, like [1] or [2].

Format (Markdown):
- Start with one sentence that names the governing document(s) and gives the headline answer.
- For structured answers, use short "###" headings for each group, bullet points under them, and **bold** for key terms, documents and thresholds.
- Use a table only when comparing items across the same attributes.
- Do not add a closing summary that repeats what you already said.`;

const MAX_HISTORY_TURNS = 6;
const CANDIDATE_POOL = 40;
const CONTEXT_TOKEN_BUDGET = 24000;
const MAX_FULL_DOCUMENTS = 4;
const MAX_EXTRA_EXTRACTS = 6;

export interface QaSource {
  n: number;
  kind: "document" | "extract";
  citation: string;
  path: string;
  heading: string;
  score: number;
  excerpt: string;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function chunkPath(c: Chunk): string {
  return (c.meta?.path as string) ?? c.source;
}

/**
 * Stitch a document back together from its chunks. Chunks overlap by whole
 * paragraphs and each carries its section heading, so paragraphs are
 * de-duplicated, and a heading line that chunking prepended ahead of the
 * section's own Markdown heading is dropped.
 */
function reconstruct(chunks: Chunk[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...chunks].sort((a, b) => a.order - b.order)) {
    const paras = c.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    paras.forEach((p, i) => {
      if (seen.has(p)) return;
      const next = paras[i + 1];
      if (i === 0 && p === c.heading && next && next.replace(/^#+\s*/, "") === p) return;
      seen.add(p);
      out.push(p);
    });
  }
  return out.join("\n\n");
}

function documentTitle(chunks: Chunk[], path: string): string {
  const firstChunk = [...chunks].sort((a, b) => a.order - b.order)[0];
  return firstChunk?.heading || path;
}

interface RankedDocument {
  path: string;
  score: number;
  hits: [Chunk, number][];
}

/** A document's relevance is the sum of the scores of its retrieved passages. */
function rankDocuments(hits: [Chunk, number][]): RankedDocument[] {
  const byPath = new Map<string, RankedDocument>();
  for (const [chunk, score] of hits) {
    const p = chunkPath(chunk);
    const doc = byPath.get(p) ?? { path: p, score: 0, hits: [] };
    doc.score += score;
    doc.hits.push([chunk, score]);
    byPath.set(p, doc);
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score);
}

/**
 * Build the numbered context block and the matching source list. Whole
 * documents come first, in relevance order, while they fit the budget;
 * the strongest remaining passages from other documents follow as extracts.
 */
function assembleContext(allChunks: Chunk[], hits: [Chunk, number][]): { context: string; sources: QaSource[] } {
  const chunksByPath = new Map<string, Chunk[]>();
  for (const c of allChunks) {
    const p = chunkPath(c);
    if (!chunksByPath.has(p)) chunksByPath.set(p, []);
    chunksByPath.get(p)!.push(c);
  }

  const blocks: string[] = [];
  const sources: QaSource[] = [];
  const included = new Set<string>();
  let used = 0;

  for (const doc of rankDocuments(hits)) {
    if (included.size >= MAX_FULL_DOCUMENTS) break;
    const docChunks = chunksByPath.get(doc.path) ?? [];
    const title = documentTitle(docChunks, doc.path);
    const n = sources.length + 1;
    const block = `[${n}] ${title} (${doc.path}) - full document\n\n${reconstruct(docChunks)}`;
    if (used + approxTokens(block) > CONTEXT_TOKEN_BUDGET) continue;

    const [bestChunk, bestScore] = doc.hits[0];
    blocks.push(block);
    used += approxTokens(block);
    included.add(doc.path);
    sources.push({
      n,
      kind: "document",
      citation: `${title} (${doc.path})`,
      path: doc.path,
      heading: bestChunk.heading,
      score: Math.round(bestScore * 10000) / 10000,
      excerpt: bestChunk.text.slice(0, 500),
    });
  }

  let extras = 0;
  for (const [chunk, score] of hits) {
    if (extras >= MAX_EXTRA_EXTRACTS) break;
    if (included.has(chunkPath(chunk))) continue;
    const n = sources.length + 1;
    const block = `[${n}] ${citation(chunk)} - extract\n\n${chunk.text}`;
    if (used + approxTokens(block) > CONTEXT_TOKEN_BUDGET) break;
    blocks.push(block);
    used += approxTokens(block);
    extras += 1;
    sources.push({
      n,
      kind: "extract",
      citation: citation(chunk),
      path: chunkPath(chunk),
      heading: chunk.heading,
      score: Math.round(score * 10000) / 10000,
      excerpt: chunk.text.slice(0, 500),
    });
  }

  return { context: blocks.join("\n\n=====\n\n"), sources };
}

/** Everything needed to ask the model: the chat messages and the sources they cite. */
export async function buildQaRequest(
  question: string,
  history: { role: string; content: string }[] = []
): Promise<{ messages: ChatMessage[]; sources: QaSource[] } | null> {
  const store = await ingest.getStore();
  if (!store.length) return null;

  let searchQuery = question;
  if (history.length) {
    const previous = history.filter((m) => m.role === "user").map((m) => m.content);
    if (previous.length && question.split(/\s+/).length <= 8) {
      searchQuery = `${previous[previous.length - 1]} ${question}`;
    }
  }

  const hits = await store.search(searchQuery, { topK: CANDIDATE_POOL });
  const { context, sources } = assembleContext(store.chunks, hits);

  const messages: ChatMessage[] = [{ role: "system", content: QA_SYSTEM }];
  for (const turn of history.slice(-MAX_HISTORY_TURNS * 2)) {
    if ((turn.role === "user" || turn.role === "assistant") && turn.content) {
      messages.push({ role: turn.role, content: String(turn.content).slice(0, 4000) });
    }
  }
  messages.push({
    role: "user",
    content:
      `## DOCUMENTS\n\n${context}\n\n## QUESTION\n${question}\n\n` +
      "Answer from the documents above. Be complete: include every requirement, condition and exception that the " +
      "documents state on this subject, from every document that covers it. Be exact: state nothing a document " +
      "does not say - no inferred consequences, process links or rules. Cite sources as [n].",
  });
  return { messages, sources };
}

export type QaEvent =
  | { type: "sources"; sources: QaSource[] }
  | { type: "delta"; text: string }
  | { type: "done"; api_calls: number };

/**
 * Answer a question as a stream of events: the sources first (so the reader
 * sees what is being consulted straight away), then the answer text as the
 * model writes it, then a completion marker.
 */
export async function* answerStream(
  question: string,
  history: { role: string; content: string }[] = []
): AsyncGenerator<QaEvent> {
  const request = await buildQaRequest(question, history);
  if (!request) {
    yield {
      type: "delta",
      text: "The knowledge base is empty. Add the framework documents and standard templates to the `frameworks/` folder, then press Rebuild Index.",
    };
    yield { type: "done", api_calls: 0 };
    return;
  }

  yield { type: "sources", sources: request.sources };

  if (!settings.llmConfigured) {
    yield {
      type: "delta",
      text: "No NVIDIA API key is configured, so I cannot compose an answer. The most relevant framework documents are listed below.",
    };
    yield { type: "done", api_calls: 0 };
    return;
  }

  const stats = new llm.CallStats();
  let wroteAnything = false;
  try {
    for await (const text of llm.chatStream(request.messages, {
      purpose: "qa",
      temperature: 0.2,
      maxTokens: 4096,
      stats,
      models: [settings.qaModel, settings.qaModelFallback],
    })) {
      wroteAnything = true;
      yield { type: "delta", text };
    }
  } catch (exc) {
    const message =
      exc instanceof llm.BudgetExhausted || exc instanceof llm.AccessDenied
        ? (exc as Error).message
        : `The model call failed: ${(exc as Error).message}\n\nThe most relevant documents are listed below.`;
    yield { type: "delta", text: wroteAnything ? `\n\n---\n\n_${message}_` : message };
  }
  yield { type: "done", api_calls: stats.calls };
}
