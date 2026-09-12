/**
 * Layer 0: checks that need no model at all. Port of app/deterministic.py.
 *
 * Roughly half of what reviewers send back ("the logframe is missing", "the
 * budget doesn't add up") is decidable by parsing. Doing that here makes
 * those findings free, instant and perfectly repeatable.
 */
import type { ExtractedDoc } from "./extract";
import type { DeterministicCheck, Rubric, SectionSpec } from "./rubric";
import { sectionAllNames } from "./rubric";

const SEVERITY_ORDER: Record<string, number> = { blocker: 0, major: 1, minor: 2, info: 3 };

export interface Finding {
  id: string;
  title: string;
  status: "pass" | "fail" | "warn";
  severity: string;
  detail: string;
  remedy: string;
  evidence: string;
}

function finding(
  id: string,
  title: string,
  status: Finding["status"],
  severity: string,
  extra: Partial<Pick<Finding, "detail" | "remedy" | "evidence">> = {}
): Finding {
  return { id, title, status, severity, detail: "", remedy: "", evidence: "", ...extra };
}

export interface DeterministicReport {
  findings: Finding[];
  missing_sections: string[];
  present_sections: string[];
  word_count: number;
}

export function failures(report: DeterministicReport): Finding[] {
  return report.findings
    .filter((f) => f.status !== "pass")
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

export function blockers(report: DeterministicReport): Finding[] {
  return report.findings.filter((f) => f.status === "fail" && f.severity === "blocker");
}

/** Share of checks passed, 0-100. Feeds the structural component of the score. */
export function completeness(report: DeterministicReport): number {
  if (!report.findings.length) return 100.0;
  const weights: Record<string, number> = { blocker: 3.0, major: 2.0, minor: 1.0, info: 0.0 };
  const total = report.findings.reduce((s, f) => s + (weights[f.severity] ?? 1.0), 0);
  if (total === 0) return 100.0;
  const earned = report.findings.filter((f) => f.status === "pass").reduce((s, f) => s + (weights[f.severity] ?? 1.0), 0);
  const partial = report.findings.filter((f) => f.status === "warn").reduce((s, f) => s + (weights[f.severity] ?? 1.0) * 0.5, 0);
  return Math.round(Math.min(100.0, ((earned + partial) / total) * 100) * 10) / 10;
}

function normalise(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
}

function tokens(text: string): Set<string> {
  return new Set(normalise(text).split(/\s+/).filter(Boolean));
}

export function findSection(doc: ExtractedDoc, spec: SectionSpec): [boolean, string] {
  const headingTexts = doc.headings.map((h) => [h.text, normalise(h.text)] as const);
  for (const name of sectionAllNames(spec)) {
    const target = normalise(name);
    const targetTokens = tokens(name);
    if (!targetTokens.size) continue;
    for (const [original, normalised] of headingTexts) {
      if (target && normalised.includes(target)) return [true, original];
      const overlap = new Set([...targetTokens].filter((t) => tokens(normalised).has(t)));
      if (overlap.size >= Math.max(1, targetTokens.size - 1) && overlap.size / targetTokens.size >= 0.6) {
        return [true, original];
      }
    }
  }
  const body = normalise(doc.text);
  for (const name of sectionAllNames(spec)) {
    if (body.includes(normalise(name))) return [true, `(found in body text, not as a heading: '${name}')`];
  }
  return [false, ""];
}

function sectionBody(doc: ExtractedDoc, headingText: string): string {
  for (let i = 0; i < doc.headings.length; i++) {
    if (doc.headings[i].text === headingText) {
      const end = i + 1 < doc.headings.length ? doc.headings[i + 1].offset : doc.text.length;
      return doc.text.slice(doc.headings[i].offset, end);
    }
  }
  return "";
}

// --------------------------------------------------------------------------
// Built-in checks
// --------------------------------------------------------------------------
const PLACEHOLDERS =
  /\b(tbd|to be decided|to be confirmed|tba|lorem ipsum|xxx+|placeholder|insert\s+(?:text|name|here)|<[^>\n]{2,40}>|\[(?:insert|add|your|name|date|amount)[^\]\n]{0,40}\])/gi;

const NUMBER_RE = /(?<![\w.])(?:INR|Rs\.?|₹|\$)?\s?(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g;
const DATE_RE =
  /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}|FY\s?\d{2,4}\s?[-/]\s?\d{2,4})\b/gi;
const TABLE_OPEN = /\[TABLE \d+\]/g;

/** Manual forward scan pairing each [TABLE n] opener with the next [/TABLE] closer - O(n), never backtracking. */
function extractWordTableBlocks(text: string): string[] {
  const blocks: string[] = [];
  let pos = 0;
  for (;;) {
    TABLE_OPEN.lastIndex = pos;
    const opener = TABLE_OPEN.exec(text);
    if (!opener) break;
    const start = opener.index + opener[0].length;
    const end = text.indexOf("[/TABLE]", start);
    if (end === -1) break;
    blocks.push(text.slice(start, end));
    pos = end + "[/TABLE]".length;
  }
  return blocks;
}

function toNumber(raw: string): number | null {
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function checkPlaceholders(doc: ExtractedDoc): Finding {
  const hits = [...doc.text.matchAll(PLACEHOLDERS)];
  const flat = Array.from(new Set(hits.map((h) => (h[1] ?? h[0]).trim()).filter(Boolean))).sort();
  if (!flat.length) {
    return finding("BUILTIN-PLACEHOLDER", "No unfilled template placeholders", "pass", "major");
  }
  return finding("BUILTIN-PLACEHOLDER", "Unfilled template placeholders remain", "fail", "major", {
    detail: `Found ${hits.length} placeholder marker(s): ${flat.slice(0, 8).join(", ")}`,
    remedy: "Replace every placeholder with the actual value before submitting for review.",
  });
}

const TOTAL_CELL = /^(?:grand\s+|sub[-\s]?)?total\b/i;
const SUBTOTAL_CELL = /^sub[-\s]?total\b/i;
const MD_SEPARATOR = /^[\s|:\-—–]+$/;
const MONEY_SIGNAL = /(?:₹|\bINR\b|\bRs\.?\b|\bUSD\b|\$|\blakh\b|\bcrore\b|\bbudget\b|\bcost\b|\bexpenditure\b|\bamount\b|\bunit\s+price\b)/i;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((p) => p.replace(/^[*_\s]+|[*_\s]+$/g, "").trim());
}

function isTotalRow(row: string): boolean {
  return cells(row).some((c) => c && c.length <= 60 && TOTAL_CELL.test(c));
}

function isGrandTotalRow(row: string): boolean {
  return cells(row).some((c) => c && c.length <= 60 && TOTAL_CELL.test(c) && !SUBTOTAL_CELL.test(c));
}

function candidateTables(text: string): string[][] {
  const tables: string[][] = [];

  for (const block of extractWordTableBlocks(text)) {
    const rows = block
      .trim()
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    if (rows.length >= 3) tables.push(rows);
  }

  let run: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if ((stripped.match(/\|/g) ?? []).length >= 2) {
      if (!MD_SEPARATOR.test(stripped)) run.push(stripped);
      continue;
    }
    if (run.length >= 3) tables.push(run);
    run = [];
  }
  if (run.length >= 3) tables.push(run);

  return tables;
}

function rowAmount(row: string): number | null {
  const values = [...row.matchAll(NUMBER_RE)]
    .map((m) => toNumber(m[0]))
    .filter((v): v is number => v != null && v > 0);
  if (!values.length) return null;
  if (row.includes("%") && values.length > 1) {
    const filtered = values.filter((v) => v > 100);
    if (!filtered.length) return null;
    return Math.max(...filtered);
  }
  return Math.max(...values);
}

/** Verify that a table stating a total actually sums to it. */
export function checkBudgetArithmetic(doc: ExtractedDoc): Finding | null {
  for (const rows of candidateTables(doc.text)) {
    if (!MONEY_SIGNAL.test(rows.join("\n"))) continue;

    const grandTotals = rows.filter(isGrandTotalRow);
    if (!grandTotals.length) continue;

    const totalRow = grandTotals[grandTotals.length - 1];
    const stated = rowAmount(totalRow);
    if (!stated || stated <= 0) continue;

    const lineValues = rows.filter((r) => !isTotalRow(r)).map(rowAmount).filter((v): v is number => v != null);
    if (lineValues.length < 2) continue;

    const computed = lineValues.reduce((a, b) => a + b, 0);
    const drift = Math.abs(computed - stated);
    if (drift <= Math.max(1.0, stated * 0.01)) {
      return finding("BUILTIN-BUDGET-SUM", "Budget table totals reconcile", "pass", "blocker", {
        detail: `${lineValues.length} line items sum to ${computed.toLocaleString()}, matching the stated total.`,
      });
    }
    return finding("BUILTIN-BUDGET-SUM", "Budget table does not add up", "fail", "blocker", {
      detail: `Line items sum to ${computed.toLocaleString()} but the stated total is ${stated.toLocaleString()} (a difference of ${drift.toLocaleString()}).`,
      remedy: "Correct the budget table so the line items reconcile with the stated total.",
      evidence: totalRow.slice(0, 200),
    });
  }
  return null;
}

export function runRubricCheck(check: DeterministicCheck, doc: ExtractedDoc): Finding {
  const text = doc.text;
  const lower = text.toLowerCase();

  if (check.type === "keyword_any") {
    const found = check.terms.filter((t) => lower.includes(t.toLowerCase()));
    const ok = found.length >= check.min_count;
    return finding(check.id, check.description, ok ? "pass" : "fail", check.severity, {
      detail: ok
        ? `Matched: ${found.join(", ")}`
        : `None of these appear anywhere in the document: ${check.terms.join(", ")}`,
      remedy: check.remedy,
    });
  }

  if (check.type === "keyword_all") {
    const missing = check.terms.filter((t) => !lower.includes(t.toLowerCase()));
    return finding(check.id, check.description, missing.length ? "fail" : "pass", check.severity, {
      detail: missing.length ? `Missing: ${missing.join(", ")}` : "All expected terms present.",
      remedy: check.remedy,
    });
  }

  if (check.type === "pattern") {
    let matches: RegExpMatchArray[];
    try {
      matches = [...text.matchAll(new RegExp(check.pattern, "gim"))];
    } catch (exc) {
      return finding(check.id, check.description, "warn", "info", { detail: `Invalid pattern: ${(exc as Error).message}` });
    }
    const ok = matches.length >= check.min_count;
    return finding(check.id, check.description, ok ? "pass" : "fail", check.severity, {
      detail: `${matches.length} match(es); ${check.min_count} required.`,
      remedy: check.remedy,
      evidence: matches[0] ? String(matches[0][0]).slice(0, 200) : "",
    });
  }

  if (check.type === "table_present") {
    const count = extractWordTableBlocks(text).length || (text.match(/^.+\|.+\|.+$/gm) ?? []).length;
    const ok = count >= check.min_count;
    return finding(check.id, check.description, ok ? "pass" : "fail", check.severity, {
      detail: `Detected ${count} table-like block(s); ${check.min_count} required.`,
      remedy: check.remedy,
    });
  }

  if (check.type === "date_present") {
    const matches = [...text.matchAll(DATE_RE)];
    const ok = matches.length >= check.min_count;
    return finding(check.id, check.description, ok ? "pass" : "fail", check.severity, {
      detail: `Found ${matches.length} date reference(s); ${check.min_count} required.`,
      remedy: check.remedy,
    });
  }

  if (check.type === "number_present") {
    const matches = [...text.matchAll(NUMBER_RE)];
    const ok = matches.length >= check.min_count;
    return finding(check.id, check.description, ok ? "pass" : "fail", check.severity, {
      detail: `Found ${matches.length} numeric value(s); ${check.min_count} required.`,
      remedy: check.remedy,
    });
  }

  return finding(check.id, check.description, "warn", "info", { detail: `Unknown check type '${check.type}'; skipped.` });
}

export function run(doc: ExtractedDoc, rubric: Rubric): DeterministicReport {
  const report: DeterministicReport = {
    findings: [],
    missing_sections: [],
    present_sections: [],
    word_count: doc.text.split(/\s+/).filter(Boolean).length,
  };

  for (const spec of rubric.sections) {
    const [present, where] = findSection(doc, spec);
    if (present) report.present_sections.push(spec.title);
    else if (spec.required) report.missing_sections.push(spec.title);

    if (!present) {
      report.findings.push(
        finding(`SECTION-${spec.id}`, `Section present: ${spec.title}`, spec.required ? "fail" : "warn", spec.required ? "blocker" : "minor", {
          detail:
            `No section matching '${spec.title}' was found.` +
            (spec.aliases.length ? ` Accepted alternatives: ${spec.aliases.join(", ")}.` : ""),
          remedy: `Add a '${spec.title}' section following the standard template.`,
        })
      );
      continue;
    }

    const bodyWords = !where.startsWith("(") ? sectionBody(doc, where).split(/\s+/).filter(Boolean).length : 0;
    if (spec.min_words && bodyWords && bodyWords < spec.min_words) {
      report.findings.push(
        finding(`SECTION-${spec.id}-LEN`, `Section depth: ${spec.title}`, "warn", "minor", {
          detail: `Approximately ${bodyWords} words; the template expects at least ${spec.min_words}.`,
          remedy: `Expand '${spec.title}' with the detail the template asks for.`,
        })
      );
    } else if (spec.max_words && bodyWords > spec.max_words) {
      report.findings.push(
        finding(`SECTION-${spec.id}-LEN`, `Section length: ${spec.title}`, "warn", "minor", {
          detail: `Approximately ${bodyWords} words against a ${spec.max_words}-word limit.`,
          remedy: `Tighten '${spec.title}' to the stated limit.`,
        })
      );
    } else {
      report.findings.push(
        finding(`SECTION-${spec.id}`, `Section present: ${spec.title}`, "pass", spec.required ? "blocker" : "minor", {
          detail: `Matched heading: ${where}`,
        })
      );
    }
  }

  for (const check of rubric.checks) report.findings.push(runRubricCheck(check, doc));

  report.findings.push(checkPlaceholders(doc));
  const budget = checkBudgetArithmetic(doc);
  if (budget) report.findings.push(budget);

  for (const warning of doc.warnings) {
    report.findings.push(finding("EXTRACTION", "Document extraction", "warn", "info", { detail: warning }));
  }

  return report;
}
