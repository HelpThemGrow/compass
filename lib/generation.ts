/**
 * Layer 3: generate a new document from a short description. Port of
 * app/generation.py.
 *
 * The inverse of evaluate.ts. Both share the same grounding principle:
 * content is written with the actual framework in front of the model, not
 * from the model's general notions of what a proposal or charter contains.
 *
 * Two families of document type:
 * - project_charter / project_proposal have a real corporate .docx template
 *   (doc_templates/) and an authored generation guide (generation/*.yaml).
 * - concept_note has no real corporate template supplied, so it falls back
 *   to reusing the scoring rubric's `sections` list as the structure to
 *   write into. project_renewal is verification-only and not offered here.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as yaml from "js-yaml";
import { settings } from "./config";
import * as llm from "./llm";
import * as ingest from "./ingest";
import { formatContext } from "./store";
import * as rubricLib from "./rubric";
import { TemplateDoc } from "./docxEngine";

const GENERATION_DIR = settings.generationDir;
const DOC_TEMPLATES_DIR = settings.docTemplatesDir;
const GENERATED_DIR = settings.generatedDir;

// --------------------------------------------------------------------------
// Guide model
// --------------------------------------------------------------------------
export type BlockKind = "bullets" | "paragraph" | "textbox" | "key_value" | "cover" | "fields" | "list" | "list_by_key";

export interface GenBlock {
  id: string;
  heading: string;
  kind: BlockKind;
  guidance: string;
  framework_query: string;
  count: [number, number];
  columns: string[];
  fields: string[];
  heading_level: number | null;
  occurrence: number;
  key_column: string;
}

export interface GenBatch {
  id: string;
  title: string;
  blocks: GenBlock[];
}

export interface GenerationGuide {
  id: string;
  name: string;
  description: string;
  docx_template: string | null;
  batches: GenBatch[];
}

function allBlocks(guide: GenerationGuide): GenBlock[] {
  return guide.batches.flatMap((b) => b.blocks);
}

export class GenerationError extends Error {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseYamlGuide(payload: any, source: string): GenerationGuide {
  const defs = new Map<string, Record<string, unknown>>();
  for (const s of payload.sections ?? []) defs.set(s.id, s);
  for (const t of payload.tables ?? []) defs.set(t.id, t);

  function makeBlock(bid: string): GenBlock {
    const d = defs.get(bid);
    if (!d) throw new GenerationError(`${source}: batch references unknown block id '${bid}'`);
    const count = (d.count as [number, number] | undefined) ?? [2, 6];
    return {
      id: bid,
      heading: String(d.heading),
      kind: String(d.kind) as BlockKind,
      guidance: String(d.guidance ?? ""),
      framework_query: String(d.framework_query ?? d.heading),
      count: [Number(count[0]), Number(count[1])],
      columns: (d.columns as string[] | undefined) ?? [],
      fields: (d.fields as string[] | undefined) ?? [],
      heading_level: d.heading_level != null ? Number(d.heading_level) : null,
      occurrence: Number(d.occurrence ?? 0),
      key_column: String(d.key_column ?? ""),
    };
  }

  const batches: GenBatch[] = (payload.batches ?? []).map((b: Record<string, unknown>) => ({
    id: String(b.id),
    title: String(b.title ?? b.id),
    blocks: (b.blocks as string[]).map(makeBlock),
  }));
  if (!batches.length) throw new GenerationError(`${source}: no batches defined`);

  return {
    id: String(payload.id),
    name: String(payload.name),
    description: String(payload.description ?? ""),
    docx_template: (payload.docx_template as string | undefined) ?? null,
    batches,
  };
}

function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Derive a generation guide from an existing scoring rubric. */
function guideFromRubric(docType: string, batchSize = 4): GenerationGuide {
  const r = rubricLib.get(docType);
  const criteriaText = rubricLib
    .allCriteria(r)
    .map((c) => `- [${c.id}] ${c.requirement}`)
    .join("\n");
  const guidance =
    `Write this section of a ${r.name} so that, taken together with the rest of the document, it would satisfy ` +
    `these framework criteria wherever they apply to this section (most sections only touch a few of them - use ` +
    `judgement, don't force-fit every criterion into every section). The bracketed ids like [BUD-01] are for your ` +
    `reference only, to know what a reviewer will check for - never write them, or any other internal code, into ` +
    `the document text itself:\n${criteriaText}`;

  const blocks: GenBlock[] = r.sections.map((s) => ({
    id: s.id,
    heading: s.title,
    kind: "bullets",
    guidance,
    framework_query: `${s.title} ${r.name}`,
    count: [3, 8],
    columns: [],
    fields: [],
    heading_level: null,
    occurrence: 0,
    key_column: "",
  }));

  const batches: GenBatch[] = chunksOf(blocks, batchSize).map((chunk, i) => ({
    id: `batch${i}`,
    title: `${r.name} — part ${i + 1}`,
    blocks: chunk,
  }));

  return { id: r.id, name: r.name, description: r.description, docx_template: null, batches };
}

// --------------------------------------------------------------------------
// Budget arithmetic reconciliation
// --------------------------------------------------------------------------
const AMOUNT_COLUMN = /amount|cost|budget|price|estimate/i;
const TOTAL_ROW_LABEL = /^\s*(grand\s+)?total\b/i;
const NUMBER_TOKEN = /[\d][\d,]*(?:\.\d+)?/;

function parseAmount(text: string): [number, string, string] | null {
  const match = NUMBER_TOKEN.exec(String(text ?? ""));
  if (!match) return null;
  const value = parseFloat(match[0].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const t = String(text ?? "");
  return [value, t.slice(0, match.index), t.slice(match.index + match[0].length)];
}

/** 1234567 -> "12,34,567" - Indian digit grouping. */
function formatIndian(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.round(Math.abs(n)));
  if (digits.length <= 3) return sign + digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  return `${sign}${groups.join(",")},${last3}`;
}

function reconcileListTotals(block: GenBlock, rows: Record<string, string>[]): Record<string, string>[] {
  if ((block.kind !== "list" && block.kind !== "list_by_key") || !rows.length || block.columns.length < 2) return rows;
  const labelCol = block.columns[0];
  const amountCol = block.columns.slice(1).find((c) => AMOUNT_COLUMN.test(c));
  if (!amountCol) return rows;
  const totalIdx = rows.findIndex((r) => TOTAL_ROW_LABEL.test(String(r[labelCol] ?? "")));
  if (totalIdx === -1) return rows;

  const parsed = rows.filter((_, i) => i !== totalIdx).map((r) => parseAmount(r[amountCol])).filter((p): p is [number, string, string] => p != null);
  if (parsed.length < 2) return rows;

  const total = parsed.reduce((s, [v]) => s + v, 0);
  const prefixes = parsed.map(([, p]) => p);
  const suffixes = parsed.map(([, , s]) => s);
  const mostCommon = (arr: string[]) => {
    const counts = new Map<string, number>();
    for (const a of arr) counts.set(a, (counts.get(a) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };
  const prefix = mostCommon(prefixes);
  const suffix = mostCommon(suffixes);
  rows[totalIdx] = { ...rows[totalIdx], [amountCol]: `${prefix}${formatIndian(total)}${suffix}` };
  return rows;
}

// --------------------------------------------------------------------------
// Types available without an authored guide - see module docstring.
// --------------------------------------------------------------------------
const RUBRIC_BACKED_TYPES = new Set(["concept_note"]);

const guideCache = new Map<string, { guide: GenerationGuide; mtime: number }>();

export function availableTypes() {
  const out: { id: string; name: string; description: string }[] = [];
  if (fs.existsSync(GENERATION_DIR)) {
    for (const f of fs.readdirSync(GENERATION_DIR).filter((f) => f.endsWith(".yaml")).sort()) {
      try {
        const payload = yaml.load(fs.readFileSync(path.join(GENERATION_DIR, f), "utf-8")) as Record<string, unknown>;
        out.push({ id: String(payload.id), name: String(payload.name), description: String(payload.description ?? "") });
      } catch {
        /* skip an unparsable guide */
      }
    }
  }
  for (const docType of RUBRIC_BACKED_TYPES) {
    try {
      const r = rubricLib.get(docType);
      out.push({ id: r.id, name: r.name, description: r.description });
    } catch {
      /* rubric not available */
    }
  }
  return out;
}

export function getGuide(docType: string): GenerationGuide {
  const guidePath = path.join(GENERATION_DIR, `${docType}.yaml`);
  if (fs.existsSync(guidePath)) {
    const mtime = fs.statSync(guidePath).mtimeMs;
    const cached = guideCache.get(docType);
    if (cached && cached.mtime === mtime) return cached.guide;
    const payload = yaml.load(fs.readFileSync(guidePath, "utf-8"));
    const guide = parseYamlGuide(payload, path.basename(guidePath));
    guideCache.set(docType, { guide, mtime });
    return guide;
  }
  if (RUBRIC_BACKED_TYPES.has(docType)) return guideFromRubric(docType);
  throw new GenerationError(`Unknown document type '${docType}'. Available: ${availableTypes().map((t) => t.id).join(", ")}`);
}

// --------------------------------------------------------------------------
// Generation
// --------------------------------------------------------------------------
const SYSTEM_PROMPT = `You draft internal planning and funding documents for an education non-profit, strictly grounded in two sources: the user's own description of their project, and the organisation's framework extracts provided to you.

Rules:
1. Every concrete fact (a number, a policy threshold, a required declaration) must come from the FRAMEWORK EXTRACTS if it states one, or from the USER'S DESCRIPTION. Never invent a specific figure, date, or person's name that neither source gives you. Where information is genuinely not available, write "To be determined" or "Pending" rather than fabricating something plausible.
2. Write in the specific, concrete style of someone who has actually thought about this project - not generic project-management boilerplate that could apply to any initiative. If the user's description is thin on a section, write the most reasonable, specific draft you can from what they did say, and keep it short rather than padding with vague filler.
3. Follow each block's instruction on how many bullets/rows to produce and respect its stated bounds.
4. Guidance may reference internal codes in brackets, like [BUD-01], to tell you what a reviewer will check for. Those codes are for your reference only - never write one into the document text itself; a real document does not cite its own scoring rubric.
5. Return JSON only, matching the schema you are given.`;

async function frameworkContext(query: string, topK = 4): Promise<string> {
  const store = await ingest.getStore();
  if (!store.length) return "";
  const hits = await store.search(query, { topK });
  return formatContext(hits, 2000);
}

function blockSchema(block: GenBlock): object {
  if (block.kind === "bullets") {
    return { type: "array", items: { type: "string" }, minItems: block.count[0], maxItems: block.count[1] };
  }
  if (block.kind === "paragraph" || block.kind === "textbox") return { type: "string" };
  if (block.kind === "key_value" || block.kind === "cover" || block.kind === "fields") {
    return { type: "object", additionalProperties: { type: "string" } };
  }
  if (block.kind === "list" || block.kind === "list_by_key") {
    return {
      type: "array",
      items: { type: "object", properties: Object.fromEntries(block.columns.map((c) => [c, { type: "string" }])) },
      minItems: block.count[0],
      maxItems: block.count[1],
    };
  }
  throw new GenerationError(`unknown block kind: ${block.kind}`);
}

function blockPrompt(block: GenBlock, framework: string): string {
  const lines = [`### ${block.heading}  (id: ${block.id})`, `Guidance: ${block.guidance}`];
  if (block.kind === "bullets") lines.push(`Produce ${block.count[0]}-${block.count[1]} bullet strings.`);
  else if (block.kind === "paragraph" || block.kind === "textbox") lines.push("Produce ONE flowing paragraph of prose (no bullets, no line breaks).");
  else if (block.kind === "key_value" || block.kind === "cover" || block.kind === "fields") lines.push(`Fields to fill: ${block.fields.join(", ")}`);
  else if (block.kind === "list" || block.kind === "list_by_key") lines.push(`Produce ${block.count[0]}-${block.count[1]} rows, each an object with keys: ${block.columns.join(", ")}`);
  if (framework) lines.push(`Relevant framework extracts:\n${framework}`);
  return lines.join("\n");
}

function defaultFor(kind: BlockKind): unknown {
  if (kind === "key_value" || kind === "cover" || kind === "fields") return {};
  if (kind === "paragraph" || kind === "textbox") return "";
  return [];
}

async function generateBatch(docName: string, description: string, batch: GenBatch, stats: llm.CallStats): Promise<Record<string, unknown>> {
  const blockPrompts: string[] = [];
  for (const block of batch.blocks) {
    const framework = await frameworkContext(block.framework_query);
    blockPrompts.push(blockPrompt(block, framework));
  }

  const schema = {
    type: "object",
    properties: Object.fromEntries(batch.blocks.map((b) => [b.id, blockSchema(b)])),
    required: batch.blocks.map((b) => b.id),
  };

  const user = `## PROJECT DESCRIPTION (from the user)
${description}

## WHAT TO WRITE — ${batch.title}
${blockPrompts.join("\n")}

## TASK
For the document "${docName}", write the content for every block listed above. Return one JSON object keyed by each block's id.`;

  const defaultResult: Record<string, unknown> = Object.fromEntries(batch.blocks.map((b) => [b.id, defaultFor(b.kind)]));

  let result: unknown;
  try {
    result = await llm.chatJson(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      { jsonSchema: schema, purpose: `generate:${batch.id}`, temperature: 0.3, maxTokens: 3000, stats }
    );
  } catch (exc) {
    return { ...defaultResult, _error: String((exc as Error).message ?? exc).slice(0, 300) };
  }

  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    // A batch with exactly one block sometimes comes back "unwrapped".
    if (batch.blocks.length === 1) return { [batch.blocks[0].id]: result };
    return { ...defaultResult, _error: `expected an object keyed by block id, got ${typeof result}` };
  }
  return result as Record<string, unknown>;
}

export interface GeneratedDocument {
  id: string;
  doc_type: string;
  doc_name: string;
  created_at: string;
  description: string;
  blocks: Record<string, { heading: string; kind: BlockKind; columns: string[]; fields: string[]; heading_level: number | null; occurrence: number; key_column: string }>;
  content: Record<string, unknown>;
  warnings: string[];
  stats: Record<string, unknown>;
}

export async function generate(docType: string, description: string): Promise<GeneratedDocument> {
  description = (description ?? "").trim();
  if (description.length < 20) {
    throw new GenerationError("Please describe the project in a bit more detail (at least a couple of sentences).");
  }

  const guide = getGuide(docType);
  const started = Date.now();
  const stats = new llm.CallStats();
  const content: Record<string, unknown> = {};
  const warnings: string[] = [];

  const blocksById = new Map(allBlocks(guide).map((b) => [b.id, b]));
  for (const batch of guide.batches) {
    const result = await generateBatch(guide.name, description, batch, stats);
    const err = result._error;
    if (err) warnings.push(`Batch '${batch.title}' had a problem and used empty defaults: ${err}`);
    for (const [bid, value] of Object.entries(result)) {
      if (bid === "_error") continue;
      const block = blocksById.get(bid);
      let v = value;
      if (block && (block.kind === "list" || block.kind === "list_by_key") && Array.isArray(v)) {
        v = reconcileListTotals(block, v as Record<string, string>[]);
      }
      content[bid] = v;
    }
  }

  const genId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const doc: GeneratedDocument = {
    id: genId,
    doc_type: guide.id,
    doc_name: guide.name,
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    description,
    blocks: Object.fromEntries(
      allBlocks(guide).map((b) => [
        b.id,
        { heading: b.heading, kind: b.kind, columns: b.columns, fields: b.fields, heading_level: b.heading_level, occurrence: b.occurrence, key_column: b.key_column },
      ])
    ),
    content,
    warnings,
    stats: {
      api_calls: stats.calls,
      purposes: stats.purposes,
      elapsed_s: Math.round(((Date.now() - started) / 1000) * 10) / 10,
      credits_remaining: llm.ledger.remaining(),
    },
  };
  persist(doc);
  return doc;
}

function persist(doc: GeneratedDocument): void {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(path.join(GENERATED_DIR, `${doc.id}.json`), JSON.stringify(doc, null, 2), "utf-8");
}

const GEN_ID_RE = /^[0-9a-f]{1,32}$/;

export function load(genId: string): GeneratedDocument | null {
  if (!GEN_ID_RE.test(genId)) return null;
  const p = path.join(GENERATED_DIR, `${genId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------
/** Universal export: works for every document type, template or not. */
export function renderMarkdown(doc: GeneratedDocument): string {
  const lines = [`# ${doc.doc_name}`, "", `_Generated ${doc.created_at} from a user description._`, ""];
  if (doc.warnings.length) {
    lines.push(`> **Note:** ${doc.warnings.join(" ")}`);
    lines.push("");
  }

  for (const [bid, block] of Object.entries(doc.blocks)) {
    const value = doc.content[bid];
    if (!value || (Array.isArray(value) && !value.length)) continue;
    lines.push(`## ${block.heading}`);
    lines.push("");
    if (block.kind === "bullets") {
      for (const item of value as string[]) lines.push(`- ${item}`);
    } else if (block.kind === "paragraph" || block.kind === "textbox") {
      lines.push(String(value));
    } else if (block.kind === "key_value" || block.kind === "cover" || block.kind === "fields") {
      const v = value as Record<string, string>;
      for (const f of block.fields) if (f in v) lines.push(`- **${f}:** ${v[f]}`);
    } else if (block.kind === "list" || block.kind === "list_by_key") {
      const cols = block.columns;
      lines.push(`| ${cols.join(" | ")} |`);
      lines.push(`|${cols.map(() => "---").join("|")}|`);
      for (const row of value as Record<string, string>[]) {
        lines.push(`| ${cols.map((c) => String(row[c] ?? "")).join(" | ")} |`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function docxTemplatePath(doc: GeneratedDocument): string | null {
  const guidePath = path.join(GENERATION_DIR, `${doc.doc_type}.yaml`);
  if (!fs.existsSync(guidePath)) return null;
  try {
    const payload = yaml.load(fs.readFileSync(guidePath, "utf-8")) as Record<string, unknown>;
    const templateName = payload.docx_template as string | undefined;
    if (!templateName) return null;
    const p = path.join(DOC_TEMPLATES_DIR, templateName);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Fill the corporate template when one exists for this document type; otherwise build a clean, generic document. */
export async function renderDocx(doc: GeneratedDocument): Promise<string> {
  const templatePath = docxTemplatePath(doc);
  const outDir = path.join(GENERATED_DIR, "docx");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${doc.id}.docx`);

  if (templatePath) await renderIntoTemplate(doc, templatePath, outPath);
  else await renderGenericDocx(doc, outPath);
  return outPath;
}

async function renderIntoTemplate(doc: GeneratedDocument, templatePath: string, outPath: string): Promise<void> {
  const buf = fs.readFileSync(templatePath);
  const t = await TemplateDoc.load(buf);

  for (const [bid, value] of Object.entries(doc.content)) {
    const block = doc.blocks[bid];
    if (!block || !value || (Array.isArray(value) && !value.length)) continue;
    try {
      if (block.kind === "bullets") {
        t.fillBullets(block.heading, value as string[], { level: block.heading_level, occurrence: block.occurrence });
      } else if (block.kind === "paragraph") {
        t.fillParagraph(block.heading, String(value), { level: block.heading_level, occurrence: block.occurrence });
      } else if (block.kind === "textbox") {
        t.fillTextBox(block.heading, String(value), { level: block.heading_level, occurrence: block.occurrence });
      } else if (block.kind === "cover") {
        t.fillCoverTable(value as Record<string, string>);
      } else if (block.kind === "fields") {
        t.fillFields(value as Record<string, string>);
      } else if (block.kind === "key_value") {
        t.fillKeyValueTable(block.heading, value as Record<string, string>, { level: block.heading_level, occurrence: block.occurrence });
      } else if (block.kind === "list") {
        t.fillListTable(block.heading, value as Record<string, string>[], { level: block.heading_level, occurrence: block.occurrence });
      } else if (block.kind === "list_by_key") {
        t.fillListTableByKey(block.heading, block.key_column, value as Record<string, string>[], { level: block.heading_level, occurrence: block.occurrence });
      }
    } catch {
      continue; // one broken block must not lose the rest of the document
    }
  }

  const outBuf = await t.save();
  fs.writeFileSync(outPath, outBuf);
}

async function renderGenericDocx(doc: GeneratedDocument, outPath: string): Promise<void> {
  const {
    Document: DocxDocument,
    Packer,
    Paragraph,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    TextRun,
  } = await import("docx");

  const children: InstanceType<typeof Paragraph | typeof Table>[] = [];
  children.push(new Paragraph({ text: doc.doc_name, heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({ children: [new TextRun({ text: `Generated ${doc.created_at} from a user description.`, italics: true })] }));

  for (const [bid, block] of Object.entries(doc.blocks)) {
    const value = doc.content[bid];
    if (!value || (Array.isArray(value) && !value.length)) continue;
    children.push(new Paragraph({ text: block.heading, heading: HeadingLevel.HEADING_1 }));

    if (block.kind === "bullets") {
      for (const item of value as string[]) children.push(new Paragraph({ text: String(item), bullet: { level: 0 } }));
    } else if (block.kind === "paragraph" || block.kind === "textbox") {
      children.push(new Paragraph({ text: String(value) }));
    } else if (block.kind === "key_value" || block.kind === "cover" || block.kind === "fields") {
      const v = value as Record<string, string>;
      const rows = block.fields
        .filter((f) => f in v)
        .map(
          (f) =>
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ text: f })] }),
                new TableCell({ children: [new Paragraph({ text: String(v[f]) })] }),
              ],
            })
        );
      if (rows.length) children.push(new Table({ rows }));
    } else if (block.kind === "list" || block.kind === "list_by_key") {
      const cols = block.columns;
      const headerRow = new TableRow({ children: cols.map((c) => new TableCell({ children: [new Paragraph({ text: c })] })) });
      const dataRows = (value as Record<string, string>[]).map(
        (row) => new TableRow({ children: cols.map((c) => new TableCell({ children: [new Paragraph({ text: String(row[c] ?? "") })] })) })
      );
      children.push(new Table({ rows: [headerRow, ...dataRows] }));
    }
  }

  const docxDoc = new DocxDocument({ sections: [{ children }] });
  const buf = await Packer.toBuffer(docxDoc);
  fs.writeFileSync(outPath, buf);
}

export function listGenerated(limit = 50) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const files = fs
    .readdirSync(GENERATED_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(GENERATED_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit);

  return files
    .map((p) => {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        return {
          id: data.id,
          doc_type: data.doc_type,
          doc_name: data.doc_name,
          created_at: data.created_at,
          description: String(data.description ?? "").slice(0, 140),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
