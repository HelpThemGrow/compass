/**
 * Rubrics: the machine-readable compilation of the framework. Port of
 * app/rubric.py.
 *
 * Rather than asking a model to "rate this proposal", the framework is
 * expressed once as versioned, weighted criteria with explicit 0-4 anchors.
 * Every score traces to a numbered criterion and a quoted framework clause.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { settings } from "./config";

export const MAX_SCORE = 4; // criterion scores run 0..4

export interface Criterion {
  id: string;
  requirement: string;
  weight: number;
  framework_refs: string[];
  evidence_hints: string[];
  anchors: Record<number, string>;
  critical: boolean;
}

export function criterionQuery(c: Criterion): string {
  return `${c.requirement} ${c.evidence_hints.join(" ")}`.trim();
}

export interface Dimension {
  id: string;
  name: string;
  weight: number;
  criteria: Criterion[];
  guidance: string;
}

export interface SectionSpec {
  id: string;
  title: string;
  required: boolean;
  aliases: string[];
  min_words: number;
  max_words: number;
}

export function sectionAllNames(s: SectionSpec): string[] {
  return [s.title, ...s.aliases];
}

export interface DeterministicCheck {
  id: string;
  description: string;
  type: string;
  severity: string;
  terms: string[];
  pattern: string;
  min_count: number;
  remedy: string;
}

export interface Rubric {
  id: string;
  name: string;
  version: string;
  description: string;
  document_types: string[];
  sections: SectionSpec[];
  checks: DeterministicCheck[];
  dimensions: Dimension[];
  source_path: string;
}

export function allCriteria(r: Rubric): Criterion[] {
  return r.dimensions.flatMap((d) => d.criteria);
}

export function dimensionOf(r: Rubric, id: string): Dimension | undefined {
  return r.dimensions.find((d) => d.id === id);
}

export function summary(r: Rubric) {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    description: r.description,
    document_types: r.document_types,
    dimension_count: r.dimensions.length,
    criteria_count: allCriteria(r).length,
    section_count: r.sections.length,
    check_count: r.checks.length,
    dimensions: r.dimensions.map((d) => ({ id: d.id, name: d.name, weight: d.weight, criteria: d.criteria.length })),
  };
}

export class RubricError extends Error {}

function asList<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseRubric(payload: any, sourcePath = ""): Rubric {
  const required = ["id", "name", "dimensions"];
  const missing = required.filter((k) => !payload?.[k]);
  if (missing.length) {
    throw new RubricError(`${sourcePath || "rubric"}: missing required key(s): ${missing.join(", ")}`);
  }

  const sections: SectionSpec[] = asList(payload.sections).map((s) => ({
    id: String(s.id ?? s.title)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_"),
    title: String(s.title).trim(),
    required: s.required ?? true,
    aliases: asList(s.aliases).map(String),
    min_words: Number(s.min_words ?? 0) || 0,
    max_words: Number(s.max_words ?? 0) || 0,
  }));

  const checks: DeterministicCheck[] = asList(payload.checks).map((c) => ({
    id: String(c.id),
    description: String(c.description ?? c.id),
    type: String(c.type ?? "keyword_any"),
    severity: String(c.severity ?? "major").toLowerCase(),
    terms: asList(c.terms).map(String),
    pattern: String(c.pattern ?? ""),
    min_count: Number(c.min_count ?? 1) || 1,
    remedy: String(c.remedy ?? ""),
  }));

  const dimensions: Dimension[] = [];
  const seenIds = new Set<string>();
  for (const d of asList(payload.dimensions)) {
    const criteria: Criterion[] = [];
    for (const c of asList(d.criteria)) {
      const cid = String(c.id).trim();
      if (seenIds.has(cid)) throw new RubricError(`${sourcePath || "rubric"}: duplicate criterion id '${cid}'`);
      seenIds.add(cid);
      const anchors: Record<number, string> = {};
      for (const [k, v] of Object.entries(c.anchors ?? {})) anchors[parseInt(k, 10)] = String(v);
      criteria.push({
        id: cid,
        requirement: String(c.requirement).trim(),
        weight: Number(c.weight ?? 1) || 1,
        framework_refs: asList(c.framework_refs).map(String),
        evidence_hints: asList(c.evidence_hints).map(String),
        anchors,
        critical: Boolean(c.critical ?? false),
      });
    }
    if (!criteria.length) throw new RubricError(`${sourcePath || "rubric"}: dimension '${d.id}' has no criteria`);
    dimensions.push({
      id: String(d.id).trim(),
      name: String(d.name ?? d.id).trim(),
      weight: Number(d.weight ?? 1) || 1,
      guidance: String(d.guidance ?? "").trim(),
      criteria,
    });
  }

  return {
    id: String(payload.id).trim(),
    name: String(payload.name).trim(),
    version: String(payload.version ?? "1.0"),
    description: String(payload.description ?? "").trim(),
    document_types: asList(payload.document_types).map(String),
    sections,
    checks,
    dimensions,
    source_path: sourcePath,
  };
}

let cache: Record<string, Rubric> = {};
let cacheMtimes: Record<string, number> = {};

/** Load every rubric YAML, reloading any file that changed on disk. */
export function loadAll(force = false): Record<string, Rubric> {
  const files = fs.existsSync(settings.rubricsDir)
    ? fs
        .readdirSync(settings.rubricsDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => path.join(settings.rubricsDir, f))
        .sort()
    : [];
  const mtimes: Record<string, number> = {};
  for (const f of files) mtimes[f] = fs.statSync(f).mtimeMs;

  const same = !force && Object.keys(mtimes).length === Object.keys(cacheMtimes).length &&
    Object.entries(mtimes).every(([k, v]) => cacheMtimes[k] === v);
  if (same && Object.keys(cache).length) return cache;

  const loaded: Record<string, Rubric> = {};
  const errors: string[] = [];
  for (const filePath of files) {
    try {
      const payload = yaml.load(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      const r = parseRubric(payload ?? {}, path.basename(filePath));
      loaded[r.id] = r;
    } catch (exc) {
      errors.push(`${path.basename(filePath)}: ${(exc as Error).message}`);
    }
  }

  if (errors.length && !Object.keys(loaded).length) {
    throw new RubricError(`No rubric could be loaded.\n${errors.join("\n")}`);
  }

  cache = loaded;
  cacheMtimes = mtimes;
  return cache;
}

export function get(rubricId: string): Rubric {
  const rubrics = loadAll();
  if (!rubrics[rubricId]) {
    throw new RubricError(`Unknown rubric '${rubricId}'. Available: ${Object.keys(rubrics).sort().join(", ") || "none"}`);
  }
  return rubrics[rubricId];
}

export function pathFor(rubricId: string): string {
  return path.join(settings.rubricsDir, `${rubricId}.yaml`);
}

/** Rank rubrics by how well they fit a document, best first. */
export function suggest(text: string) {
  const haystack = (text ?? "").toLowerCase().split(/\s+/).join(" ").slice(0, 20000);
  const rubrics = Object.values(loadAll());
  // See app/rubric.py's `suggest()` docstring for why this is normalised
  // against a shared reference size rather than each rubric's own section
  // count - otherwise a small, generic rubric can out-rank a larger, more
  // specific one purely by hitting "100% of its own sections" sooner.
  const maxSections = Math.max(1, ...rubrics.map((r) => r.sections.length).filter((n) => n > 0));

  const ranked = rubrics.map((r) => {
    let score = 0;
    const signals: string[] = [];

    for (const docType of r.document_types) {
      const term = docType.toLowerCase().trim();
      if (term && haystack.includes(term)) {
        score += 3.0;
        signals.push(docType);
      }
    }

    if (r.sections.length) {
      const matched = new Set<string>();
      for (const spec of r.sections) {
        if (haystack.includes(spec.title.toLowerCase())) {
          matched.add(spec.title);
          continue;
        }
        for (const alias of spec.aliases) {
          if (haystack.includes(alias.toLowerCase())) {
            matched.add(spec.title);
            break;
          }
        }
      }
      score += 6.0 * Math.min(1.0, matched.size / maxSections);
      signals.push(...Array.from(matched).sort().slice(0, 4));
    }

    return {
      id: r.id,
      name: r.name,
      version: r.version,
      score: Math.round(score * 100) / 100,
      criteria_count: allCriteria(r).length,
      signals: signals.slice(0, 6),
      close_call: undefined as boolean | undefined,
    };
  });

  ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.criteria_count - a.criteria_count));
  if (ranked.length > 1 && ranked[0].score > 0) {
    const margin = (ranked[0].score - ranked[1].score) / ranked[0].score;
    ranked[0].close_call = margin < 0.35;
  }
  return ranked;
}
