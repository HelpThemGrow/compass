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
// Zip parts (.docx and .xlsx are zip archives of XML)
// --------------------------------------------------------------------------
// Uploads are capped at 25 MB compressed, but a crafted archive can inflate
// to gigabytes. Each part is decompressed as a stream and abandoned as soon
// as it passes this limit, so a "zip bomb" cannot exhaust the server's memory.
const MAX_PART_BYTES = 100 * 1024 * 1024;

// JSZip documents ZipObject.internalStream() but its type definitions omit it.
interface ZipStream {
  on(event: "data", cb: (chunk: Uint8Array) => void): ZipStream;
  on(event: "error", cb: (err: Error) => void): ZipStream;
  on(event: "end", cb: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}

function readZipPart(zip: JSZip, name: string): Promise<string | undefined> {
  const entry = zip.file(name);
  if (!entry) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const stream = (entry as unknown as { internalStream(type: "uint8array"): ZipStream }).internalStream("uint8array");
    stream
      .on("data", (chunk: Uint8Array) => {
        total += chunk.length;
        if (total > MAX_PART_BYTES) {
          stream.pause();
          reject(new Error(`The file is too large once decompressed (${name} exceeds ${MAX_PART_BYTES / (1024 * 1024)} MB).`));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
      .resume();
  });
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
  const documentXml = await readZipPart(zip, "word/document.xml");
  if (!documentXml) {
    doc.warnings.push("The .docx file could not be read (missing word/document.xml).");
    return "";
  }
  const stylesXml = await readZipPart(zip, "word/styles.xml");
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
// XLSX - read the workbook XML directly with the same zip/XML libraries used
// for .docx, rather than a third-party spreadsheet parser. Only cell text is
// needed here, so formulas are never evaluated: the cached result is used.
// --------------------------------------------------------------------------
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_PERCENT_FORMATS = new Set([9, 10]);
const MAX_COLUMNS = 1024;

function byTag(root: Document | Element, tag: string): Element[] {
  return Array.from(root.getElementsByTagNameNS(S_NS, tag) as unknown as ArrayLike<Element>);
}

/** All the text inside a string item, skipping phonetic guides (<rPh>). */
function richText(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Element) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i];
      if (n.nodeType !== 1) continue;
      const child = n as Element;
      if (child.localName === "rPh") continue;
      if (child.localName === "t") parts.push(child.textContent ?? "");
      else walk(child);
    }
  };
  walk(el);
  return parts.join("");
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Strip quoted literals, [colour]/[locale] blocks and escapes before looking at format codes. */
function bareFormat(code: string): string {
  return code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
}

function plainNumber(n: number): string {
  return String(parseFloat(n.toPrecision(15)));
}

// Built-in Excel number formats that have no formatCode in styles.xml.
const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 37: "#,##0", 38: "#,##0", 39: "#,##0.00", 40: "#,##0.00",
};

/**
 * Apply the parts of a number format that carry meaning for a reader:
 * currency symbols and other literal text, thousands separators, and the
 * number of decimal places - so "₹5,000,000.00" is not flattened to 5000000.
 */
function formatNumber(num: number, code: string): string {
  const section = (code.split(";")[0] ?? "").trim();
  const firstDigit = section.search(/[0#?]/);
  if (firstDigit === -1) return plainNumber(num);
  const literals = (part: string) =>
    (part.match(/"[^"]*"|\[\$[^\]]*\]|\\./g) ?? [])
      .map((t) => (t.startsWith('"') ? t.slice(1, -1) : t.startsWith("[$") ? t.slice(2, -1).split("-")[0] : t.slice(1)))
      .join("");
  const lastDigit = Math.max(section.lastIndexOf("0"), section.lastIndexOf("#"), section.lastIndexOf("?"));
  const digits = bareFormat(section);
  const decimals = digits.match(/\.(0+)/)?.[1].length ?? 0;
  const [int, frac] = Math.abs(num).toFixed(decimals).split(".");
  const grouped = /[0#?],[0#?]/.test(digits) ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : int;
  return `${num < 0 ? "-" : ""}${literals(section.slice(0, firstDigit))}${grouped}${frac ? `.${frac}` : ""}${literals(section.slice(lastDigit + 1))}`;
}

function excelDate(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(epoch + Math.round(serial * 86_400_000)).toISOString();
  return Math.abs(serial % 1) > 1e-9 ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

async function fromXlsx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const parser = new DOMParser();
  const parse = (xml: string) => parser.parseFromString(xml, "text/xml") as unknown as Document;

  const workbookXml = await readZipPart(zip, "xl/workbook.xml");
  if (!workbookXml) throw new Error("The .xlsx file could not be read (missing xl/workbook.xml).");
  const workbook = parse(workbookXml);
  const date1904 = byTag(workbook, "workbookPr").some((el) => ["1", "true"].includes(el.getAttribute("date1904") ?? ""));

  const rels = new Map<string, string>();
  const relsXml = await readZipPart(zip, "xl/_rels/workbook.xml.rels");
  if (relsXml) {
    const relDoc = parse(relsXml);
    for (const rel of Array.from(relDoc.getElementsByTagName("Relationship") as unknown as ArrayLike<Element>)) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target") ?? "";
      if (id) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
    }
  }

  const sharedXml = await readZipPart(zip, "xl/sharedStrings.xml");
  const shared = sharedXml ? byTag(parse(sharedXml), "si").map(richText) : [];

  // Style index -> number format, to tell dates and percentages from plain numbers.
  const customFormats = new Map<number, string>();
  const cellFormats: number[] = [];
  const stylesXml = await readZipPart(zip, "xl/styles.xml");
  if (stylesXml) {
    const styles = parse(stylesXml);
    for (const nf of byTag(styles, "numFmt")) customFormats.set(Number(nf.getAttribute("numFmtId")), nf.getAttribute("formatCode") ?? "");
    const cellXfs = byTag(styles, "cellXfs")[0];
    if (cellXfs) for (const xf of byTag(cellXfs, "xf")) cellFormats.push(Number(xf.getAttribute("numFmtId") ?? 0));
  }
  const formatOf = (styleIndex: string | null) => {
    const id = cellFormats[Number(styleIndex || 0)] ?? 0;
    const raw = customFormats.get(id) ?? BUILTIN_NUMBER_FORMATS[id] ?? "";
    const code = bareFormat(raw);
    const isPercent = BUILTIN_PERCENT_FORMATS.has(id) || code.includes("%");
    const isDate = !isPercent && (BUILTIN_DATE_FORMATS.has(id) || /[dmyhs]/i.test(code.replace(/general/gi, "")));
    const decimals = isPercent ? (code.split(".")[1]?.match(/0/g)?.length ?? (id === 10 ? 2 : 0)) : 0;
    return { isDate, isPercent, decimals, raw };
  };

  const cellText = (c: Element): string => {
    const type = c.getAttribute("t") || "n"; // xmldom returns "" (not null) for a missing attribute
    const v = byTag(c, "v")[0]?.textContent ?? "";
    if (type === "s") return shared[Number(v)] ?? "";
    if (type === "inlineStr") return byTag(c, "is").map(richText).join("");
    if (type === "b") return v === "1" ? "TRUE" : v === "0" ? "FALSE" : v;
    if (type === "d") return v.length > 10 && !v.endsWith("T00:00:00") ? v.slice(0, 16).replace("T", " ") : v.slice(0, 10);
    if (type !== "n" || v === "") return v; // str (cached formula text), e (error such as #N/A)
    const num = Number(v);
    if (!Number.isFinite(num)) return v;
    const fmt = formatOf(c.getAttribute("s"));
    if (fmt.isPercent) return `${(num * 100).toFixed(fmt.decimals)}%`;
    if (fmt.isDate) return excelDate(num, date1904);
    return formatNumber(num, fmt.raw);
  };

  const parts: string[] = [];
  for (const sheet of byTag(workbook, "sheet")) {
    const name = sheet.getAttribute("name") || "Sheet";
    const relId = sheet.getAttributeNS(REL_NS, "id") || sheet.getAttribute("r:id");
    const sheetXml = relId && rels.has(relId) ? await readZipPart(zip, rels.get(relId)!) : undefined;
    if (!sheetXml) continue; // chart sheets and missing parts have no cells
    const rows: string[][] = [];
    let minCol = Infinity;
    for (const row of byTag(parse(sheetXml), "row")) {
      const cells: string[] = [];
      byTag(row, "c").forEach((c, i) => {
        const ref = c.getAttribute("r");
        const col = ref ? columnIndex(ref) : i;
        if (col < 0 || col >= MAX_COLUMNS) return;
        const text = cellText(c).trim();
        if (!text) return;
        cells[col] = text;
        minCol = Math.min(minCol, col);
      });
      if (cells.length) rows.push(cells);
    }
    parts.push(`# Sheet: ${name}`);
    for (const cells of rows) parts.push(Array.from({ length: cells.length - minCol }, (_, k) => cells[minCol + k] ?? "").join(" | "));
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
