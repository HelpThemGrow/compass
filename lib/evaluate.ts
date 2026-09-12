/**
 * Layer 1: rubric-driven verification of a submitted document. Port of
 * app/evaluate.py.
 *
 * Retrieval runs *inverted* compared to a normal RAG chatbot: the corpus is
 * the submitted document and each query is a framework criterion, so every
 * score is tied to a quoted passage from the submission itself.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { settings } from "./config";
import * as llm from "./llm";
import { approxTokens, chunkDocument } from "./chunking";
import type { ExtractedDoc } from "./extract";
import * as det from "./deterministic";
import type { Criterion, Dimension, Rubric } from "./rubric";
import { MAX_SCORE, criterionQuery } from "./rubric";
import { VectorStore, formatContext } from "./store";
import * as ingest from "./ingest";

const CONTENT_WEIGHT = 0.75;
const STRUCTURE_WEIGHT = 0.25;
const NO_EVIDENCE = "NO_EVIDENCE";

const CRITERION_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: MAX_SCORE },
          verdict: { type: "string", enum: ["met", "partially_met", "not_met", "not_applicable"] },
          evidence_quote: { type: "string" },
          evidence_location: { type: "string" },
          gap: { type: "string" },
          recommended_fix: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["id", "score", "verdict", "evidence_quote", "gap", "recommended_fix", "confidence"],
      },
    },
  },
  required: ["criteria"],
};

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    overall_summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    priority_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          why_it_matters: { type: "string" },
          criterion_ids: { type: "array", items: { type: "string" } },
          effort: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["action", "why_it_matters", "effort"],
      },
    },
    reviewer_note: { type: "string" },
  },
  required: ["overall_summary", "strengths", "priority_actions", "reviewer_note"],
};

const JUDGE_SYSTEM = `You are a compliance reviewer for a grant-making education non-profit. You check whether a submitted document satisfies the organisation's written framework.

You will be shown two clearly separated blocks. Keep them apart:

* FRAMEWORK STANDARD - the organisation's own policy. This is the yardstick. It is NEVER evidence, and you must never quote from it.
* SUBMITTED DOCUMENT - the document under review. This is the ONLY place evidence can come from.

Rules you must follow exactly:
1. Judge ONLY from the SUBMITTED DOCUMENT. Never use outside knowledge, never quote the framework standard back as if the submission had said it, and never assume something is present because it usually would be.
2. Absence of evidence is not compliance. If the submitted document does not contain the required content, score it low and set evidence_quote to "NO_EVIDENCE".
3. evidence_quote must be copied VERBATIM from the SUBMITTED DOCUMENT, at most 40 words. If you cannot find those exact words in the submitted document, the evidence does not exist - write "NO_EVIDENCE". Do not paraphrase, summarise or invent it.
4. Score each criterion 0-4 using its scoring anchors:
   4 = fully met with specific, verifiable detail
   3 = met, but detail is thin or partly generic
   2 = partially addressed; important elements missing
   1 = mentioned only in passing, no substance
   0 = absent, or contradicts the framework
5. \`gap\` states plainly what is missing or weak. \`recommended_fix\` is one concrete, actionable instruction the author can carry out - name the section and what to add.
6. Set confidence to "low" when the excerpts look truncated or ambiguous.
7. Be exacting but fair. Do not invent problems that the excerpts do not support.

Return JSON only.`;

export interface CriterionResult {
  id: string;
  requirement: string;
  dimension_id: string;
  dimension_name: string;
  weight: number;
  score: number;
  verdict: string;
  evidence_quote: string;
  evidence_location: string;
  gap: string;
  recommended_fix: string;
  confidence: string;
  framework_refs: string[];
  critical: boolean;
  evidence_verified: boolean;
}

export interface DimensionResult {
  id: string;
  name: string;
  weight: number;
  score: number;
  criteria: CriterionResult[];
}

export interface Evaluation {
  id: string;
  created_at: string;
  filename: string;
  rubric_id: string;
  rubric_name: string;
  rubric_version: string;
  overall_score: number;
  content_score: number;
  structure_score: number;
  band: string;
  band_note: string;
  capped_reason: string;
  dimensions: DimensionResult[];
  deterministic: {
    completeness: number;
    word_count: number;
    missing_sections: string[];
    present_sections: string[];
    findings: det.Finding[];
  };
  summary: Record<string, unknown>;
  stats: Record<string, unknown>;
  warnings: string[];
  rubric_suggestions: unknown[];
  auto_selected: boolean;
}

// --------------------------------------------------------------------------
// Evidence gathering
// --------------------------------------------------------------------------
const FULL_DOCUMENT_TOKEN_LIMIT = 9000;
const EVIDENCE_TOKEN_BUDGET = 7000;

function wholeDocumentContext(doc: ExtractedDoc): string {
  return `[1] Source: ${doc.source} (complete document)\n${doc.text}`;
}

async function buildSubmissionIndex(doc: ExtractedDoc, docId: string): Promise<VectorStore> {
  const chunks = chunkDocument(doc, { docId });
  for (const c of chunks) c.meta = { kind: "submission" };
  const store = new VectorStore(`submission-${docId}`);
  await store.build(chunks);
  return store;
}

async function evidenceForDimension(
  submission: VectorStore,
  dimension: Dimension,
  perCriterion: number
): Promise<[string, Record<string, string[]>]> {
  const selected = new Map<number, [import("./chunking").Chunk, number]>();
  const perCriterionLocations: Record<string, string[]> = {};

  for (const criterion of dimension.criteria) {
    const hits = await submission.search(criterionQuery(criterion), { topK: perCriterion, rerankTo: perCriterion });
    perCriterionLocations[criterion.id] = hits.map(([c]) => `${c.source} — ${c.heading}`);
    for (const [chunk, score] of hits) {
      const key = chunk.order;
      const existing = selected.get(key);
      if (!existing || score > existing[1]) selected.set(key, [chunk, score]);
    }
  }

  let values = Array.from(selected.values());
  const totalTokens = values.reduce((s, [c]) => s + approxTokens(c.text), 0);
  if (totalTokens > EVIDENCE_TOKEN_BUDGET) {
    values.sort((a, b) => b[1] - a[1]);
    const kept: typeof values = [];
    let used = 0;
    for (const [chunk, score] of values) {
      const cost = approxTokens(chunk.text);
      if (used + cost > EVIDENCE_TOKEN_BUDGET) continue;
      kept.push([chunk, score]);
      used += cost;
    }
    values = kept;
  }

  const ordered = [...values].sort((a, b) => a[0].order - b[0].order);
  return [formatContext(ordered, EVIDENCE_TOKEN_BUDGET), perCriterionLocations];
}

const frameworkCache = new Map<string, string>();

async function frameworkContext(rubric: Rubric, dimension: Dimension, topK = 4): Promise<string> {
  const store = await ingest.getStore();
  if (!store.length) return "";

  const built = ingest.statusReport().built_at;
  const key = `${rubric.id}::${rubric.version}::${dimension.id}::${built}`;
  if (frameworkCache.has(key)) return frameworkCache.get(key)!;

  const query = `${dimension.name}. ${dimension.criteria.slice(0, 6).map((c) => c.requirement).join(" ")}`;
  const context = formatContext(await store.search(query, { topK, rerankTo: topK }), 2500);
  frameworkCache.set(key, context);
  return context;
}

function criterionBlock(criterion: Criterion): string {
  const lines = [`### Criterion ${criterion.id}`, `Requirement: ${criterion.requirement}`];
  if (criterion.framework_refs.length) lines.push(`Framework reference: ${criterion.framework_refs.join("; ")}`);
  if (Object.keys(criterion.anchors).length) {
    const anchors = Object.entries(criterion.anchors)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    lines.push(`Scoring anchors: ${anchors}`);
  }
  return lines.join("\n");
}

interface RawCriterionResult {
  id: string;
  score?: number;
  verdict?: string;
  evidence_quote?: string;
  evidence_location?: string;
  gap?: string;
  recommended_fix?: string;
  confidence?: string;
}

function fallbackResults(dimension: Dimension, reason: string): RawCriterionResult[] {
  return dimension.criteria.map((c) => ({
    id: c.id,
    score: 0,
    verdict: "not_met",
    evidence_quote: NO_EVIDENCE,
    evidence_location: "",
    gap: `This criterion could not be assessed automatically: ${reason}`,
    recommended_fix: "Review this criterion manually before submitting to the board.",
    confidence: "low",
  }));
}

async function judgeDimension(
  dimension: Dimension,
  rubric: Rubric,
  evidence: string,
  framework: string,
  stats: llm.CallStats
): Promise<RawCriterionResult[]> {
  if (!evidence.trim()) return fallbackResults(dimension, "no matching content was found in the document");

  const criteriaText = dimension.criteria.map(criterionBlock).join("\n\n");
  const guidance = dimension.guidance ? `\nDimension guidance: ${dimension.guidance}\n` : "";
  const frameworkBlock = framework
    ? "## FRAMEWORK STANDARD — REFERENCE ONLY, NEVER QUOTE AS EVIDENCE\nThis is the organisation's own policy, included so you know what the criteria mean.\nIt is not part of the submission.\n\n" +
      `${framework}\n\n`
    : "";

  const whole = evidence.trimStart().startsWith("[1] Source:") && evidence.slice(0, 200).includes("(complete document)");
  const evidenceNote = whole
    ? "This is the complete submitted document."
    : "These are the passages retrieved from the submitted document as most relevant to the criteria above. If a criterion's required content is not visible here, treat it as absent.";

  const user = `## ASSESSMENT DIMENSION
${dimension.name} (from rubric "${rubric.name}" v${rubric.version})${guidance}

${frameworkBlock}## CRITERIA TO ASSESS
${criteriaText}

## SUBMITTED DOCUMENT — THE ONLY SOURCE OF EVIDENCE
${evidenceNote}

${evidence}

## TASK
Assess every criterion listed above, in order. Return one object per criterion with its exact id. Set evidence_location to the heading in the SUBMITTED DOCUMENT that the quote came from. Before writing each evidence_quote, confirm those exact words appear in the SUBMITTED DOCUMENT above and not in the framework standard.`;

  try {
    const payload = (await llm.chatJson(
      [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: user },
      ],
      { jsonSchema: CRITERION_SCHEMA, purpose: `judge:${dimension.id}`, temperature: 0.05, maxTokens: 3500, stats }
    )) as { criteria?: RawCriterionResult[] };
    const items = payload?.criteria;
    return Array.isArray(items) ? items : [];
  } catch (exc) {
    if (exc instanceof llm.BudgetExhausted || exc instanceof llm.LLMUnavailable || exc instanceof llm.AccessDenied) {
      throw exc; // account-level problems affect every dimension; fail loudly once
    }
    return fallbackResults(dimension, String((exc as Error).message ?? exc).slice(0, 200));
  }
}

// --------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------
const MD_MARKUP = /[*_`#|]+/g;
const LITERAL_BACKSLASH_N = /\\n/g;

function normaliseForMatch(text: string): string {
  let t = (text ?? "").toLowerCase().replace(MD_MARKUP, " ");
  t = t.replace(LITERAL_BACKSLASH_N, " ");
  t = t.replace(/'/g, "'").replace(/[“”]/g, '"');
  return t.replace(/\s+/g, " ").trim();
}

function quoteIsReal(quote: string, haystack: string): boolean {
  const q = normaliseForMatch(quote);
  if (q.length < 12) return true;

  const window = 30;
  if (q.length <= window) return haystack.includes(q);

  const stride = Math.max(1, Math.floor((q.length - window) / 4));
  const starts = new Set<number>();
  for (let s = 0; s <= q.length - window; s += stride) starts.add(s);
  starts.add(q.length - window);
  const sortedStarts = Array.from(starts).sort((a, b) => a - b);
  const probes = sortedStarts.map((s) => q.slice(s, s + window));

  if (!haystack.includes(probes[0]) || !haystack.includes(probes[probes.length - 1])) return false;
  const hits = probes.filter((p) => haystack.includes(p)).length;
  return hits >= Math.max(2, Math.round(probes.length * 0.6));
}

function collate(
  dimension: Dimension,
  raw: RawCriterionResult[],
  locations: Record<string, string[]>,
  document = ""
): DimensionResult {
  const byId = new Map(raw.filter((i) => i && typeof i === "object").map((i) => [String(i.id ?? "").trim(), i]));
  const results: CriterionResult[] = [];

  for (const criterion of dimension.criteria) {
    const item = byId.get(criterion.id) ?? ({} as RawCriterionResult);
    let score = Number.isFinite(Number(item.score)) ? Math.trunc(Number(item.score)) : 0;
    score = Math.max(0, Math.min(MAX_SCORE, score));

    let quote = String(item.evidence_quote ?? "").trim();
    if (quote.toUpperCase().startsWith(NO_EVIDENCE)) quote = "";

    let gap = String(item.gap ?? "");
    let verified = true;
    if (quote && document && !quoteIsReal(quote, document)) {
      verified = false;
      gap = (
        "The supporting quote cited for this criterion could not be found in the submitted document, " +
        "so this score is unverified and should be checked by hand. " +
        gap
      ).trim();
      quote = "";
    }

    let location = String(item.evidence_location ?? "").trim();
    if (!location) {
      const found = locations[criterion.id] ?? [];
      location = found[0] ?? "";
    }

    results.push({
      id: criterion.id,
      requirement: criterion.requirement,
      dimension_id: dimension.id,
      dimension_name: dimension.name,
      weight: criterion.weight,
      score,
      verdict: String(item.verdict ?? "not_met"),
      evidence_quote: quote,
      evidence_location: location,
      gap,
      recommended_fix: String(item.recommended_fix ?? ""),
      confidence: !verified ? "low" : String(item.confidence ?? "low"),
      framework_refs: criterion.framework_refs,
      critical: criterion.critical,
      evidence_verified: verified,
    });
  }

  const scored = results.filter((r) => r.verdict !== "not_applicable");
  const denominator = scored.reduce((s, r) => s + r.weight, 0) * MAX_SCORE;
  const numerator = scored.reduce((s, r) => s + r.weight * r.score, 0);
  const score = denominator ? Math.round((numerator / denominator) * 1000) / 10 : 100.0;

  return { id: dimension.id, name: dimension.name, weight: dimension.weight, score, criteria: results };
}

function aggregate(dimensions: DimensionResult[], structureScore: number): [number, number] {
  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0) || 1.0;
  const content = Math.round((dimensions.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight) * 10) / 10;
  const overall = Math.round((content * CONTENT_WEIGHT + structureScore * STRUCTURE_WEIGHT) * 10) / 10;
  return [overall, content];
}

function applyCaps(overall: number, dimensions: DimensionResult[], deterministic: det.DeterministicReport): [number, string] {
  const reasons: string[] = [];
  let cap = 100.0;

  const blk = det.blockers(deterministic);
  if (blk.length) {
    cap = Math.min(cap, 59.0);
    reasons.push(`${blk.length} blocking structural check(s) failed: ${blk.slice(0, 3).map((b) => b.title).join("; ")}`);
  }

  const failedCritical = dimensions.flatMap((d) => d.criteria).filter((c) => c.critical && c.score <= 1 && c.verdict !== "not_applicable");
  if (failedCritical.length) {
    cap = Math.min(cap, 69.0);
    reasons.push(`Critical criteria unmet: ${failedCritical.slice(0, 5).map((c) => c.id).join(", ")}`);
  }

  if (overall <= cap) return [overall, ""];
  return [cap, reasons.join(" ")];
}

// --------------------------------------------------------------------------
// Narrative summary
// --------------------------------------------------------------------------
async function summarise(
  rubric: Rubric,
  dimensions: DimensionResult[],
  deterministic: det.DeterministicReport,
  overall: number,
  band: string,
  stats: llm.CallStats
): Promise<Record<string, unknown>> {
  const allCriteria = dimensions.flatMap((d) => d.criteria);
  const gaps = [...allCriteria].filter((c) => c.score < 3).sort((a, b) => a.score - b.score || b.weight - a.weight).slice(0, 14);
  const strengths = [...allCriteria].filter((c) => c.score >= 3).sort((a, b) => b.score - a.score || b.weight - a.weight).slice(0, 6);

  const gapText = gaps.length
    ? gaps.map((c) => `- [${c.id}] (${c.dimension_name}, score ${c.score}/${MAX_SCORE}) ${c.gap || c.requirement}`).join("\n")
    : "- None.";
  const strengthText = strengths.length ? strengths.map((c) => `- [${c.id}] ${c.requirement}`).join("\n") : "- None identified.";
  const structuralFailures = det.failures(deterministic).slice(0, 12);
  const structuralText = structuralFailures.length
    ? structuralFailures.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`).join("\n")
    : "- All structural checks passed.";
  const dimText = dimensions.map((d) => `- ${d.name}: ${d.score}/100 (weight ${d.weight})`).join("\n");

  const user = `A submission was assessed against the "${rubric.name}" rubric (v${rubric.version}).

RESULT: ${overall}/100, rated "${band}". This rating is already decided by the rubric arithmetic. Your summary must be consistent with it - do not tell the author the document is unfit if it rated well, or reassure them if it did not. Describe what stands between it and the next rating band up.

Dimension scores:
${dimText}

Structural check failures:
${structuralText}

Criteria scoring below 3/4:
${gapText}

Criteria scoring 3 or above:
${strengthText}

Write feedback for the programme manager who submitted this document.
- overall_summary: 3-5 sentences, consistent with the ${overall}/100 "${band}" rating above. Say plainly what state the document is in and what would move it up a band. Address the author directly. No praise padding.
- strengths: up to 4 specific things that are genuinely done well. Empty list if there are none.
- priority_actions: 3-6 actions, most important first. Each must be concrete enough to act on today, must reference the criterion ids it resolves, and must be phrased as an instruction.
- reviewer_note: one sentence to the reviewing committee on what to probe.

Do not invent facts about the project. Work only from the assessment above. Return JSON only.`;

  try {
    return (await llm.chatJson(
      [
        { role: "system", content: "You write direct, actionable review feedback for non-profit programme staff. No filler, no flattery." },
        { role: "user", content: user },
      ],
      { jsonSchema: SUMMARY_SCHEMA, purpose: "summary", temperature: 0.2, maxTokens: 1800, stats }
    )) as Record<string, unknown>;
  } catch (exc) {
    return {
      overall_summary: `Scored ${overall}/100 against ${rubric.name}. The narrative summary could not be generated (${(exc as Error).message ?? exc}), but the per-criterion findings below are complete.`,
      strengths: strengths.slice(0, 3).map((c) => c.requirement),
      priority_actions: gaps.slice(0, 5).map((c) => ({
        action: c.recommended_fix || `Address criterion ${c.id}`,
        why_it_matters: c.gap || c.requirement,
        criterion_ids: [c.id],
        effort: "medium",
      })),
      reviewer_note: "Automated summary unavailable; review the criterion table directly.",
    };
  }
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------
export async function evaluate(
  doc: ExtractedDoc,
  rubric: Rubric,
  opts: {
    filename: string;
    evidencePerCriterion?: number;
    skipLlm?: boolean;
    rubricSuggestions?: unknown[];
    autoSelected?: boolean;
  }
): Promise<Evaluation> {
  const started = Date.now();
  const stats = new llm.CallStats();
  const evalId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  const deterministic = det.run(doc, rubric);

  const dimensions: DimensionResult[] = [];
  const warnings: string[] = [...doc.warnings];
  const scoring = !opts.skipLlm && settings.llmConfigured;

  const wholeDocument = approxTokens(doc.text) <= FULL_DOCUMENT_TOKEN_LIMIT ? wholeDocumentContext(doc) : null;
  const submission = scoring && wholeDocument === null ? await buildSubmissionIndex(doc, evalId) : null;

  const haystack = normaliseForMatch(doc.text);

  let content = 0;
  let overall: number;
  let cappedReason = "";
  let summary: Record<string, unknown>;
  let band: string;
  let bandNote: string;

  if (!scoring) {
    warnings.push("Structural checks only. No NVIDIA API key is configured, so criteria were not scored.");
    for (const dimension of rubric.dimensions) {
      dimensions.push(collate(dimension, fallbackResults(dimension, "LLM scoring was skipped"), {}));
    }
    content = 0.0;
    overall = Math.round(det.completeness(deterministic) * 10) / 10;
    summary = {
      overall_summary: "Only the structural checks ran. Add an NVIDIA API key to .env.local to get criterion-level scoring and written feedback.",
      strengths: [],
      priority_actions: det.failures(deterministic).slice(0, 6).map((f) => ({
        action: f.remedy || f.title,
        why_it_matters: f.detail,
        criterion_ids: [f.id],
        effort: "medium",
      })),
      reviewer_note: "Structural pre-check only; content has not been assessed.",
    };
    band = "Structural check only";
    bandNote = "Sections and formatting were checked. The substance of the document has not been assessed.";
  } else {
    const budget = settings.maxCallsPerEvaluation;
    for (const dimension of rubric.dimensions) {
      let evidence: string;
      let locations: Record<string, string[]>;
      if (wholeDocument !== null) {
        evidence = wholeDocument;
        locations = {};
      } else {
        [evidence, locations] = await evidenceForDimension(submission!, dimension, opts.evidencePerCriterion ?? 3);
      }
      if (stats.calls >= budget - 1) {
        warnings.push(`Per-evaluation call limit (${budget}) reached; dimension '${dimension.name}' onward was not scored.`);
        dimensions.push(collate(dimension, fallbackResults(dimension, "call limit reached"), locations));
        continue;
      }
      const framework = await frameworkContext(rubric, dimension);
      const raw = await judgeDimension(dimension, rubric, evidence, framework, stats);
      dimensions.push(collate(dimension, raw, locations, haystack));
    }

    [overall, content] = aggregate(dimensions, det.completeness(deterministic));
    [overall, cappedReason] = applyCaps(overall, dimensions, deterministic);
    [band, bandNote] = settings.bandFor(overall);
    summary = await summarise(rubric, dimensions, deterministic, overall, band, stats);

    const unverified = dimensions.flatMap((d) => d.criteria).filter((c) => !c.evidence_verified);
    if (unverified.length) {
      warnings.push(
        `${unverified.length} criterion score(s) cited a quote that could not be located in the document ` +
          `(${unverified.slice(0, 6).map((c) => c.id).join(", ")}). Those findings are marked unverified and should be checked by hand.`
      );
    }
  }

  const evaluation: Evaluation = {
    id: evalId,
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    filename: opts.filename,
    rubric_id: rubric.id,
    rubric_name: rubric.name,
    rubric_version: rubric.version,
    overall_score: overall,
    content_score: content,
    structure_score: det.completeness(deterministic),
    band,
    band_note: bandNote,
    capped_reason: cappedReason,
    dimensions,
    deterministic: {
      completeness: det.completeness(deterministic),
      word_count: deterministic.word_count,
      missing_sections: deterministic.missing_sections,
      present_sections: deterministic.present_sections,
      findings: deterministic.findings,
    },
    summary,
    stats: {
      api_calls: stats.calls,
      purposes: stats.purposes,
      evidence_mode: wholeDocument !== null ? "whole document" : "retrieved excerpts",
      chunks_indexed: submission ? submission.length : 0,
      elapsed_s: Math.round(((Date.now() - started) / 1000) * 10) / 10,
      credits_remaining: llm.ledger.remaining(),
    },
    warnings,
    rubric_suggestions: opts.rubricSuggestions ?? [],
    auto_selected: opts.autoSelected ?? false,
  };

  persist(evaluation);
  return evaluation;
}

function persist(evaluation: Evaluation): void {
  fs.mkdirSync(settings.reportsDir, { recursive: true });
  const p = path.join(settings.reportsDir, `${evaluation.id}.json`);
  fs.writeFileSync(p, JSON.stringify(evaluation, null, 2), "utf-8");
}

const EVAL_ID_RE = /^[0-9a-f]{1,32}$/;

export function loadEvaluation(evalId: string): Evaluation | null {
  if (!EVAL_ID_RE.test(evalId)) return null;
  const p = path.join(settings.reportsDir, `${evalId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function listEvaluations(limit = 50) {
  fs.mkdirSync(settings.reportsDir, { recursive: true });
  const files = fs
    .readdirSync(settings.reportsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(settings.reportsDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit);

  return files
    .map((p) => {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        return {
          id: data.id,
          filename: data.filename,
          rubric_name: data.rubric_name,
          overall_score: data.overall_score,
          band: data.band,
          created_at: data.created_at,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
