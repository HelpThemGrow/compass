/**
 * Turn uploaded files into plain text plus a light structural outline.
 * Port of app/extract.py.
 *
 * The outline (heading text and its character offset) is what lets the
 * verifier say "Section 4, Budget" rather than "somewhere in the document",
 * and it powers the deterministic section-presence checks.
 */
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

export const SUPPORTED = new Set([".pdf", ".docx", ".txt", ".md", ".markdown", ".xlsx", ".csv"]);

export interface Heading {
  text: string;
  level: number;
  offset: number;
}

export interface ExtractedDoc {
  text: string;
  headings: Heading[];
  pageOffsets: number[];
  source: string;
  warnings: string[];
}

function wordCount(doc: ExtractedDoc): number {
  return doc.text.split(/\s+/).filter(Boolean).length;
}
export { wordCount };

// A heading is a short line that is numbered, ALL CAPS, markdown-hashed, or
// title-cased without terminal punctuation. Deliberately loose: a false
// positive costs a slightly odd citation label, a false negative loses a
// section boundary.
const NUMBERED = /^\s*(\d+(?:\.\d+)*)[.)]?\s+(\S.{0,90})$/;
const MD_HEADING = /^\s{0,3}(#{1,6})\s+(\S.*)$/;
const UNDERLINE = /^\s*[=\-_]{3,}\s*$/;

function stripEmphasis(text: string): string {
  return text.replace(/^[*_\s]+|[*_\s]+$/g, "").trim();
}

function isHeading(line: string): [boolean, number, string] {
  let stripped = line.trim();
  if (!stripped || stripped.length > 120) return [false, 0, ""];

  const md = MD_HEADING.exec(line);
  if (md) return [true, md[1].length, stripEmphasis(md[2])];

  if (stripped.includes("|") || stripped.includes("\t")) return [false, 0, ""];
  if (/^[*_]{1,2}\S/.test(stripped) && stripped.includes(":")) return [false, 0, ""];

  const letters = [...stripped].filter((c) => /[a-zA-Z]/.test(c)).length;
  if (letters < Math.max(3, stripped.length * 0.45)) return [false, 0, ""];

  stripped = stripEmphasis(stripped);
  if (!stripped) return [false, 0, ""];

  const num = NUMBERED.exec(stripped);
  if (num && !/[.;,]$/.test(stripped)) {
    const depth = (num[1].match(/\./g)?.length ?? 0) + 1;
    return [true, Math.min(depth, 4), stripped];
  }

  const letterChars = [...stripped].filter((c) => /[a-zA-Z]/.test(c));
  if (letterChars.length >= 3 && letterChars.every((c) => c === c.toUpperCase()) && stripped.split(/\s+/).length <= 12) {
    return [true, 1, stripped];
  }

  const words = stripped.split(/\s+/);
  if (
    words.length >= 2 &&
    words.length <= 10 &&
    !/[.?!,;:]$/.test(stripped) &&
    words.filter((w) => /^[A-Z]/.test(w[0] ?? "")).length >= Math.max(2, words.length - 2)
  ) {
    return [true, 2, stripped];
  }

  return [false, 0, ""];
}

function outline(text: string): Heading[] {
  const headings: Heading[] = [];
  let offset = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (UNDERLINE.test(line) && i > 0 && lines[i - 1].trim()) {
      const prev = lines[i - 1].trim();
      const last = headings[headings.length - 1];
      if (last && last.text === prev) {
        last.level = 1;
      } else {
        headings.push({ text: prev, level: 1, offset: Math.max(0, offset - lines[i - 1].length - 1) });
      }
    } else {
      const [ok, level, label] = isHeading(line);
      if (ok) headings.push({ text: label, level, offset });
    }
    offset += line.length + 1;
  }
  return headings;
}

// --------------------------------------------------------------------------
// PDF
// --------------------------------------------------------------------------
async function fromPdf(buf: Buffer, doc: ExtractedDoc): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  let result;
  try {
    result = await parser.getText();
  } finally {
    await parser.destroy();
  }

  const parts: string[] = [];
  let cursor = 0;
  let emptyPages = 0;
  for (const page of result.pages) {
    const content = page.text ?? "";
    if (!content.trim()) emptyPages += 1;
    doc.pageOffsets.push(cursor);
    const block = `${content.trim()}\n\n`;
    parts.push(block);
    cursor += block.length;
  }
  if (emptyPages && emptyPages === result.pages.length) {
    doc.warnings.push("No text layer found in this PDF. It is probably a scan; run OCR before uploading.");
  } else if (emptyPages) {
    doc.warnings.push(`${emptyPages} page(s) had no extractable text and were skipped.`);
  }
  return parts.join("");
}

// --------------------------------------------------------------------------
// DOCX - minimal OOXML walk: paragraphs (with heading styles) + tables.
// --------------------------------------------------------------------------
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function childrenByTag(el: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 1 && (n as Element).localName === tag) out.push(n as Element);
  }
  return out;
}

function firstByTag(el: Element, tag: string): Element | null {
  return childrenByTag(el, tag)[0] ?? null;
}

function paragraphText(p: Element): string {
  const texts: string[] = [];
  const walk = (node: Element) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i];
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      if (el.localName === "t") texts.push(el.textContent ?? "");
      else if (el.localName === "tab") texts.push("\t");
      else if (el.localName === "br" || el.localName === "cr") texts.push("\n");
      else walk(el);
    }
  };
  walk(p);
  return texts.join("");
}

function buildStyleNameMap(stylesXml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!stylesXml) return map;
  const doc = new DOMParser().parseFromString(stylesXml, "text/xml");
  const styles = doc.getElementsByTagNameNS(W_NS, "style");
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i] as unknown as Element;
    const id = style.getAttributeNS(W_NS, "styleId") || style.getAttribute("w:styleId");
    const nameEl = firstByTag(style, "name");
    const name = nameEl?.getAttributeNS(W_NS, "val") || nameEl?.getAttribute("w:val");
    if (id && name) map.set(id, name);
  }
  return map;
}

function resolveStyleName(styleId: string | null, map: Map<string, string>): string {
  if (!styleId) return "normal";
  if (map.has(styleId)) return map.get(styleId)!.toLowerCase();
  const m = /^Heading(\d)$/i.exec(styleId);
  if (m) return `heading ${m[1]}`;
  if (/^Title$/i.test(styleId)) return "title";
  return styleId.toLowerCase();
}

async function fromDocx(buf: Buffer, doc: ExtractedDoc): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    doc.warnings.push("The .docx file could not be read (missing word/document.xml).");
    return "";
  }
  const stylesXml = await zip.file("word/styles.xml")?.async("string");
  const styleMap = buildStyleNameMap(stylesXml);

  const xml = new DOMParser().parseFromString(documentXml, "text/xml");
  const body = xml.getElementsByTagNameNS(W_NS, "body")[0] as unknown as Element;
  if (!body) return "";

  const parts: string[] = [];
  let tableIndex = 0;

  for (let i = 0; i < body.childNodes.length; i++) {
    const node = body.childNodes[i];
    if (node.nodeType !== 1) continue;
    const el = node as Element;

    if (el.localName === "p") {
      const text = paragraphText(el).trim();
      if (!text) continue;
      const pPr = firstByTag(el, "pPr");
      const pStyle = pPr ? firstByTag(pPr, "pStyle") : null;
      const styleId = pStyle?.getAttributeNS(W_NS, "val") || pStyle?.getAttribute("w:val") || null;
      const styleName = resolveStyleName(styleId, styleMap);
      if (styleName.startsWith("heading")) {
        const level = styleName.match(/\d+/)?.[0] || "1";
        parts.push(`${"#".repeat(Math.min(parseInt(level, 10), 6))} ${text}`);
      } else if (styleName.startsWith("title")) {
        parts.push(`# ${text}`);
      } else {
        parts.push(text);
      }
    } else if (el.localName === "tbl") {
      tableIndex += 1;
      parts.push(`\n[TABLE ${tableIndex}]`);
      const rows = childrenByTag(el, "tr");
      for (const row of rows) {
        const cells = childrenByTag(row, "tc").map((tc) => {
          const cellParas = childrenByTag(tc, "p").map((p) => paragraphText(p).trim());
          return cellParas.join(" ").trim();
        });
        if (cells.some(Boolean)) parts.push(cells.join(" | "));
      }
      parts.push("[/TABLE]\n");
    }
  }

  if (!parts.length) doc.warnings.push("The .docx file contained no readable paragraphs or tables.");
  return parts.join("\n\n");
}

// --------------------------------------------------------------------------
// XLSX
// --------------------------------------------------------------------------
async function fromXlsx(buf: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    parts.push(`# Sheet: ${sheetName}`);
    const sheet = wb.Sheets[sheetName];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    for (const row of rows) {
      const cells = row.map((v) => (v == null ? "" : String(v).trim()));
      if (cells.some(Boolean)) parts.push(cells.join(" | "));
    }
    parts.push("");
  }
  return parts.join("\n");
}

// --------------------------------------------------------------------------
// CSV - a small compliant parser (quoted fields, embedded commas/newlines).
// --------------------------------------------------------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function fromCsv(text: string): string {
  const rows: string[] = [];
  for (const row of parseCsv(text)) {
    if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()).join(" | "));
  }
  return rows.join("\n");
}

// --------------------------------------------------------------------------
// Normalisation
// --------------------------------------------------------------------------
function normalise(text: string): string {
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/ /g, " ").replace(/﻿/g, "");
  text = text.replace(/(\w)-\n(\w)/g, "$1$2");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export async function extract(filePath: string): Promise<ExtractedDoc> {
  const suffix = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.has(suffix)) {
    throw new Error(`Unsupported file type '${suffix}'. Supported: ${[...SUPPORTED].sort().join(", ")}`);
  }

  const doc: ExtractedDoc = { text: "", headings: [], pageOffsets: [], source: path.basename(filePath), warnings: [] };
  const buf = await fs.readFile(filePath);

  let raw: string;
  if (suffix === ".pdf") raw = await fromPdf(buf, doc);
  else if (suffix === ".docx") raw = await fromDocx(buf, doc);
  else if (suffix === ".xlsx") raw = await fromXlsx(buf);
  else if (suffix === ".csv") raw = fromCsv(buf.toString("utf-8"));
  else raw = buf.toString("utf-8");

  doc.text = normalise(raw);
  doc.headings = outline(doc.text);
  if (!doc.text.trim()) doc.warnings.push("No text could be extracted from this file.");
  return doc;
}
