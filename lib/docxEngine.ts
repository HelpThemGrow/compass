/**
 * Generic Word-template filling engine. Direct TypeScript port of
 * app/docx_engine.py.
 *
 * Fills an arbitrary corporate .docx template (headings + placeholder
 * scaffolding + tables) with generated content, manipulating the underlying
 * OOXML directly through JSZip + a real XML DOM (@xmldom/xmldom) - no Word,
 * no LibreOffice, nothing native.
 *
 * The approach: identify a heading by text, wipe whatever placeholder
 * scaffolding sits between it and the next heading, and rebuild that gap
 * from either an existing bulleted-list style found nearby, or a shared
 * fallback bullet style found anywhere else in the document. Tables are
 * located by walking forward from a heading to the first <w:tbl> before the
 * next heading, then filled either by matching row labels or extending rows.
 *
 * What this does NOT do: recompute the document's Table of Contents field -
 * that needs a layout engine this app deliberately doesn't depend on.
 */
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlDoc = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlEl = any;

const HEADING_NUM_PREFIX = /^\d+(\.\d+)*\.?\s+/;
const WS_RE = /\s+/g;
const AUTO_NUMBER_COLUMN = /^\s*(#|no\.?|s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?)\s*$/i;

function norm(text: string): string {
  return (text ?? "").trim().replace(WS_RE, " ").toLowerCase();
}

function normKey(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stripHeadingNumber(text: string): string {
  return (text ?? "").replace(HEADING_NUM_PREFIX, "").trim();
}

function isEl(node: unknown): node is XmlEl {
  return !!node && (node as { nodeType?: number }).nodeType === 1;
}

function children(el: XmlEl, localName?: string): XmlEl[] {
  const out: XmlEl[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (isEl(n) && (!localName || n.localName === localName)) out.push(n);
  }
  return out;
}

function first(el: XmlEl, localName: string): XmlEl | null {
  return children(el, localName)[0] ?? null;
}

/** Every direct/nested descendant with a given local name, depth-first. */
function findAll(el: XmlEl, localName: string): XmlEl[] {
  const out: XmlEl[] = [];
  const walk = (node: XmlEl) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i];
      if (!isEl(n)) continue;
      if (n.localName === localName) out.push(n);
      walk(n);
    }
  };
  walk(el);
  return out;
}

function attr(el: XmlEl, localName: string): string | null {
  // xmldom stores attributes with their raw qualified name (e.g. "w:val");
  // try the namespaced accessor first, then fall back to a manual scan.
  const viaNs = el.getAttributeNS?.(W_NS, localName);
  if (viaNs) return viaNs;
  for (let i = 0; i < (el.attributes?.length ?? 0); i++) {
    const a = el.attributes[i];
    if (a.localName === localName || a.name === `w:${localName}`) return a.value;
  }
  return null;
}

function setText(t: XmlEl, doc: XmlDoc, value: string): void {
  while (t.firstChild) t.removeChild(t.firstChild);
  t.appendChild(doc.createTextNode(value));
  t.setAttribute("xml:space", "preserve");
}

function elText(el: XmlEl): string {
  const parts: string[] = [];
  const walk = (node: XmlEl) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i];
      if (!isEl(n)) continue;
      if (n.localName === "t") parts.push(n.textContent ?? "");
      else if (n.localName === "tab") parts.push("\t");
      else if (n.localName === "br" || n.localName === "cr") parts.push("\n");
      else walk(n);
    }
  };
  walk(el);
  return parts.join("");
}

function styleVal(pOrTr: XmlEl): string | null {
  const pPr = first(pOrTr, "pPr");
  if (!pPr) return null;
  const pStyle = first(pPr, "pStyle");
  return pStyle ? attr(pStyle, "val") : null;
}

function headingLevel(styleValue: string | null): number | null {
  if (!styleValue || !/^Heading/i.test(styleValue)) return null;
  const digits = styleValue.match(/\d+/)?.[0];
  return digits ? parseInt(digits, 10) : 1;
}

function numprNumId(pEl: XmlEl): string | null {
  const pPr = first(pEl, "pPr");
  if (!pPr) return null;
  const numPr = first(pPr, "numPr");
  if (!numPr) return null;
  const numIdEl = first(numPr, "numId");
  return numIdEl ? attr(numIdEl, "val") : null;
}

function iterRuns(pEl: XmlEl): XmlEl[] {
  return children(pEl, "r");
}

export class TemplateNotFound extends Error {}

export class TemplateDoc {
  private zip!: JSZip;
  private buf: Buffer;
  private doc!: XmlDoc;
  private body!: XmlEl;
  private numberingDoc: XmlDoc | null = null;
  private usesStyleHeadings = false;
  private numIdFormats = new Map<string, string>();
  private headingNumIds = new Set<string>();
  private fallbackBulletEl: XmlEl | null = null;
  private representativeRunStyle: XmlEl | null = null;
  private ready: Promise<void>;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.ready = this.init();
  }

  static async load(buf: Buffer): Promise<TemplateDoc> {
    const t = new TemplateDoc(buf);
    await t.ready;
    return t;
  }

  private async init(): Promise<void> {
    this.zip = await JSZip.loadAsync(this.buf);
    const documentXml = await this.zip.file("word/document.xml")!.async("string");
    this.doc = new DOMParser().parseFromString(documentXml, "text/xml");
    this.body = first(this.doc.documentElement, "body")!;

    const numberingXml = await this.zip.file("word/numbering.xml")?.async("string");
    if (numberingXml) this.numberingDoc = new DOMParser().parseFromString(numberingXml, "text/xml");

    this.usesStyleHeadings = this.allParagraphs().some((p) => headingLevel(styleVal(p)) !== null);
    this.numIdFormats = this.collectNumIdFormats();
    this.headingNumIds = this.collectHeadingNumIds();
    this.fallbackBulletEl = this.findAnyBulletElement();
    this.representativeRunStyle = this.findRepresentativeRunStyle();
    this.fixHeadingNumbering();
  }

  private allParagraphs(): XmlEl[] {
    return findAll(this.body, "p");
  }

  // -- discovery -----------------------------------------------------
  private collectNumIdFormats(): Map<string, string> {
    const map = new Map<string, string>();
    if (!this.numberingDoc) return map;
    const abstractFmt = new Map<string, string>();
    for (const absNum of findAll(this.numberingDoc.documentElement, "abstractNum")) {
      const absId = attr(absNum, "abstractNumId");
      const lvl0 = children(absNum, "lvl").find((l) => attr(l, "ilvl") === "0");
      const fmtEl = lvl0 ? first(lvl0, "numFmt") : null;
      const fmt = fmtEl ? attr(fmtEl, "val") : null;
      if (absId && fmt) abstractFmt.set(absId, fmt);
    }
    for (const num of findAll(this.numberingDoc.documentElement, "num")) {
      const numId = attr(num, "numId");
      const absEl = first(num, "abstractNumId");
      const absId = absEl ? attr(absEl, "val") : null;
      if (numId && absId && abstractFmt.has(absId)) map.set(numId, abstractFmt.get(absId)!);
    }
    return map;
  }

  private collectHeadingNumIds(): Set<string> {
    const ids = new Set<string>();
    for (const p of this.allParagraphs()) {
      if (headingLevel(styleVal(p)) !== null) {
        const numId = numprNumId(p);
        if (numId) ids.add(numId);
      }
    }
    return ids;
  }

  private isBulletCandidate(pEl: XmlEl): boolean {
    const numId = numprNumId(pEl);
    if (numId === null || this.headingNumIds.has(numId)) return false;
    const fmt = this.numIdFormats.get(numId);
    return fmt === undefined || fmt === "bullet";
  }

  private findAnyBulletElement(): XmlEl | null {
    for (const p of this.allParagraphs()) {
      if (styleVal(p) === null && this.isBulletCandidate(p)) return p;
    }
    return null;
  }

  private firstAvailableBulletNumId(): string | null {
    for (const [numId, fmt] of this.numIdFormats) {
      if (fmt === "bullet" && !this.headingNumIds.has(numId)) return numId;
    }
    return null;
  }

  private findRepresentativeRunStyle(): XmlEl | null {
    const BODY_SIZE_CEILING_HALFPT = 26; // ~13pt in half-points, matching sz units
    for (const p of this.allParagraphs()) {
      const style = styleVal(p);
      const text = elText(p).trim();
      if (style !== null || text.length < 15) continue;
      if (numprNumId(p) !== null) continue;
      const runs = iterRuns(p);
      if (!runs.length) continue;
      const run = runs[0];
      const rPr = first(run, "rPr");
      if (!rPr) continue;
      const bold = first(rPr, "b");
      if (bold && attr(bold, "val") !== "0" && attr(bold, "val") !== "false") continue;
      const szEl = first(rPr, "sz");
      const sz = szEl ? parseInt(attr(szEl, "val") ?? "0", 10) : 0;
      if (sz > BODY_SIZE_CEILING_HALFPT * 2) continue; // w:sz is in half-points
      return rPr;
    }
    return null;
  }

  private effectiveHeadingLevel(pEl: XmlEl): number | null {
    const level = headingLevel(styleVal(pEl));
    if (level !== null || this.usesStyleHeadings) return level;
    const runs = iterRuns(pEl);
    if (!runs.length) return null;
    const text = elText(pEl).trim();
    if (!text || text.length > 120) return null;
    const rPr = first(runs[0], "rPr");
    const bold = rPr ? first(rPr, "b") : null;
    const isBold = !!bold && attr(bold, "val") !== "0" && attr(bold, "val") !== "false";
    return isBold ? 1 : null;
  }

  headingParagraph(text: string, opts: { required?: boolean; level?: number | null; occurrence?: number } = {}): XmlEl | null {
    const { required = true, level = null, occurrence = 0 } = opts;
    const target = norm(text);
    const matches: XmlEl[] = [];
    for (const p of this.allParagraphs()) {
      const foundLevel = this.effectiveHeadingLevel(p);
      if (foundLevel === null) continue;
      if (level !== null && foundLevel !== level) continue;
      const pText = elText(p);
      const candidate = norm(stripHeadingNumber(pText));
      if (candidate === target || norm(pText) === target) matches.push(p);
    }
    if (occurrence < matches.length) return matches[occurrence];
    if (required) throw new TemplateNotFound(`heading not found in template: ${text} (level=${level}, occurrence=${occurrence})`);
    return null;
  }

  private nextHeadingElement(startEl: XmlEl, maxLevel: number): XmlEl | null {
    let el = startEl.nextSibling;
    while (el) {
      if (isEl(el) && el.localName === "p") {
        const level = this.effectiveHeadingLevel(el);
        if (level !== null && level <= maxLevel) return el;
      }
      el = el.nextSibling;
    }
    return null;
  }

  // -- one-time template repairs --------------------------------------
  private fixHeadingNumbering(): void {
    let lastGood: [string | null, XmlEl] | null = null;
    for (const p of this.allParagraphs()) {
      const style = styleVal(p);
      if (headingLevel(style) === null) continue;
      const pPr = first(p, "pPr");
      const numPr = pPr ? first(pPr, "numPr") : null;
      const hasPrefix = HEADING_NUM_PREFIX.test(elText(p));
      if (numPr) {
        lastGood = [style, numPr];
        continue;
      }
      if (hasPrefix && lastGood && lastGood[0] === style) {
        const runs = iterRuns(p);
        if (runs.length) {
          const t = first(runs[0], "t");
          if (t) setText(t, this.doc, stripHeadingNumber(elText(p)));
          for (const extra of runs.slice(1)) p.removeChild(extra);
        }
        const newPPr = pPr ?? p.insertBefore(this.doc.createElementNS(W_NS, "w:pPr"), p.firstChild);
        newPPr.insertBefore(lastGood[1].cloneNode(true), newPPr.firstChild);
      }
    }
  }

  // -- run/paragraph construction --------------------------------------
  private setSingleRun(pEl: XmlEl, text: string): void {
    const runs = iterRuns(pEl);
    if (!runs.length) return;
    const first0 = runs[0];
    for (const t of children(first0, "t")) first0.removeChild(t);
    const t = this.doc.createElementNS(W_NS, "w:t");
    setText(t, this.doc, text);
    first0.appendChild(t);
    for (const extra of runs.slice(1)) pEl.removeChild(extra);
  }

  private cloneBullet(templateEl: XmlEl, text: string): XmlEl {
    const newEl = templateEl.cloneNode(true);
    if (iterRuns(newEl).length) {
      this.setSingleRun(newEl, text);
    } else {
      const r = this.doc.createElementNS(W_NS, "w:r");
      const t = this.doc.createElementNS(W_NS, "w:t");
      setText(t, this.doc, text);
      r.appendChild(t);
      newEl.appendChild(r);
    }
    return newEl;
  }

  private makeBulletParagraph(text: string): XmlEl {
    const numId = this.firstAvailableBulletNumId();
    const pEl = this.doc.createElementNS(W_NS, "w:p");
    if (numId !== null) {
      const pPr = this.doc.createElementNS(W_NS, "w:pPr");
      const numPr = this.doc.createElementNS(W_NS, "w:numPr");
      const ilvl = this.doc.createElementNS(W_NS, "w:ilvl");
      ilvl.setAttribute("w:val", "0");
      const numIdEl = this.doc.createElementNS(W_NS, "w:numId");
      numIdEl.setAttribute("w:val", numId);
      numPr.appendChild(ilvl);
      numPr.appendChild(numIdEl);
      pPr.appendChild(numPr);
      pEl.appendChild(pPr);
    }
    const runEl = this.doc.createElementNS(W_NS, "w:r");
    if (this.representativeRunStyle) runEl.appendChild(this.representativeRunStyle.cloneNode(true));
    const t = this.doc.createElementNS(W_NS, "w:t");
    setText(t, this.doc, text);
    runEl.appendChild(t);
    pEl.appendChild(runEl);
    return pEl;
  }

  // -- section filling ---------------------------------------------------
  /** Replace everything between a heading and the next heading with one bullet per item. */
  fillBullets(headingText: string, items: string[], opts: { maxLevel?: number; level?: number | null; occurrence?: number } = {}): void {
    if (!items.length) return;
    const { maxLevel = 2, level = null, occurrence = 0 } = opts;
    const headingPara = this.headingParagraph(headingText, { level, occurrence })!;
    const stopEl = this.nextHeadingElement(headingPara, maxLevel);

    const scaffold: XmlEl[] = [];
    let el = headingPara.nextSibling;
    while (el && el !== stopEl) {
      const nxt = el.nextSibling;
      if (isEl(el) && el.localName === "p") scaffold.push(el);
      el = nxt;
    }

    const found = scaffold.find((e) => this.isBulletCandidate(e)) ?? null;
    const bulletTemplate = found ?? this.fallbackBulletEl;

    for (const e of scaffold) e.parentNode.removeChild(e);

    let anchor = headingPara;
    for (const text of items) {
      let newEl: XmlEl;
      if (bulletTemplate) {
        newEl = this.cloneBullet(bulletTemplate, text);
      } else if (this.firstAvailableBulletNumId() !== null) {
        newEl = this.makeBulletParagraph(text);
      } else {
        newEl = this.doc.createElementNS(W_NS, "w:p");
        const r = this.doc.createElementNS(W_NS, "w:r");
        const t = this.doc.createElementNS(W_NS, "w:t");
        setText(t, this.doc, text);
        r.appendChild(t);
        newEl.appendChild(r);
      }
      anchor.parentNode.insertBefore(newEl, anchor.nextSibling);
      anchor = newEl;
    }
  }

  /** Replace everything between a heading and the next heading with a single plain paragraph of prose. */
  fillParagraph(headingText: string, text: string, opts: { maxLevel?: number; level?: number | null; occurrence?: number } = {}): void {
    if (!text) return;
    const { maxLevel = 2, level = null, occurrence = 0 } = opts;
    const headingPara = this.headingParagraph(headingText, { level, occurrence })!;
    const stopEl = this.nextHeadingElement(headingPara, maxLevel);

    const scaffold: XmlEl[] = [];
    let el = headingPara.nextSibling;
    while (el && el !== stopEl) {
      const nxt = el.nextSibling;
      if (isEl(el) && el.localName === "p") scaffold.push(el);
      el = nxt;
    }
    for (const e of scaffold) e.parentNode.removeChild(e);

    const pEl = this.doc.createElementNS(W_NS, "w:p");
    const runEl = this.doc.createElementNS(W_NS, "w:r");
    if (this.representativeRunStyle) runEl.appendChild(this.representativeRunStyle.cloneNode(true));
    const t = this.doc.createElementNS(W_NS, "w:t");
    setText(t, this.doc, text);
    runEl.appendChild(t);
    pEl.appendChild(runEl);
    headingPara.parentNode.insertBefore(pEl, headingPara.nextSibling);
  }

  /** Fill several "Label: [placeholder]" paragraphs anywhere in the document by label. */
  fillFields(fields: Record<string, string>): void {
    for (const [label, value] of Object.entries(fields)) {
      if (value) this.setCoverField(label, value);
    }
  }

  // -- table discovery -----------------------------------------------
  tableAfter(headingText: string, opts: { required?: boolean; level?: number | null; occurrence?: number } = {}): XmlEl | null {
    const { required = true, level = null, occurrence = 0 } = opts;
    const headingPara = this.headingParagraph(headingText, { required, level, occurrence });
    if (!headingPara) return null;
    let el = headingPara.nextSibling;
    while (el) {
      if (isEl(el) && el.localName === "tbl") return el;
      if (isEl(el) && el.localName === "p" && this.effectiveHeadingLevel(el) !== null) break;
      el = el.nextSibling;
    }
    if (required) throw new TemplateNotFound(`no table found after heading: ${headingText}`);
    return null;
  }

  private tableRows(tbl: XmlEl): XmlEl[] {
    return children(tbl, "tr");
  }

  private rowCells(tr: XmlEl): XmlEl[] {
    return children(tr, "tc");
  }

  private static lookupColumn(rowData: Record<string, string>, colName: string): string | undefined {
    if (colName in rowData) return rowData[colName];
    const target = normKey(colName);
    const exact = Object.entries(rowData).filter(([k]) => normKey(k) === target);
    if (exact.length) return exact[0][1];
    for (const [k, v] of Object.entries(rowData)) {
      const kNorm = normKey(k);
      if (kNorm && (target.includes(kNorm) || kNorm.includes(target))) return v;
    }
    return undefined;
  }

  // -- table cell/row formatting ---------------------------------------
  private referenceRunStyle(tbl: XmlEl): { fontName: string; bold: boolean; color: string | null } {
    const rows = this.tableRows(tbl);
    const bodyRows = rows.length > 1 ? rows.slice(1) : rows;
    for (const row of bodyRows) {
      for (const cell of this.rowCells(row)) {
        for (const p of children(cell, "p")) {
          for (const r of iterRuns(p)) {
            const rPr = first(r, "rPr");
            const text = elText(r).trim();
            if (rPr && text) {
              const rFonts = first(rPr, "rFonts");
              const fontName = rFonts ? attr(rFonts, "ascii") ?? "Calibri" : "Calibri";
              const b = first(rPr, "b");
              const bold = !!b && attr(b, "val") !== "0" && attr(b, "val") !== "false";
              const colorEl = first(rPr, "color");
              const color = colorEl ? attr(colorEl, "val") : null;
              return { fontName, bold, color: color && color !== "auto" ? color : null };
            }
          }
        }
      }
    }
    return { fontName: "Calibri", bold: false, color: "767171" };
  }

  private setCellText(cell: XmlEl, text: string, styleRef: { fontName: string; bold: boolean; color: string | null }): void {
    const paras = children(cell, "p");
    const p = paras[0] ?? cell.appendChild(this.doc.createElementNS(W_NS, "w:p"));
    const runs = iterRuns(p);
    let run: XmlEl;
    if (runs.length) {
      run = runs[0];
      const t = first(run, "t") ?? run.appendChild(this.doc.createElementNS(W_NS, "w:t"));
      setText(t, this.doc, text);
      for (const extra of runs.slice(1)) p.removeChild(extra);
    } else {
      run = this.doc.createElementNS(W_NS, "w:r");
      const t = this.doc.createElementNS(W_NS, "w:t");
      setText(t, this.doc, text);
      run.appendChild(t);
      p.appendChild(run);
    }
    let rPr = first(run, "rPr");
    if (!rPr) {
      rPr = this.doc.createElementNS(W_NS, "w:rPr");
      run.insertBefore(rPr, run.firstChild);
    }
    // Reset then reapply, so a re-filled cell doesn't accumulate stale formatting.
    for (const tag of ["rFonts", "b", "color"]) {
      const existing = first(rPr, tag);
      if (existing) rPr.removeChild(existing);
    }
    const rFonts = this.doc.createElementNS(W_NS, "w:rFonts");
    rFonts.setAttribute("w:ascii", styleRef.fontName);
    rFonts.setAttribute("w:hAnsi", styleRef.fontName);
    rPr.appendChild(rFonts);
    if (styleRef.bold) {
      const b = this.doc.createElementNS(W_NS, "w:b");
      rPr.appendChild(b);
    }
    if (styleRef.color) {
      const color = this.doc.createElementNS(W_NS, "w:color");
      color.setAttribute("w:val", styleRef.color);
      rPr.appendChild(color);
    }
    for (const extraP of paras.slice(1)) cell.removeChild(extraP);
  }

  private cloneRow(tbl: XmlEl): XmlEl {
    const rows = this.tableRows(tbl);
    const isHeaderOnly = rows.length === 1;
    const templateTr = rows[rows.length - 1];
    const newTr = templateTr.cloneNode(true);
    if (isHeaderOnly) this.stripHeaderCellStyling(newTr);
    tbl.appendChild(newTr);
    return newTr;
  }

  private stripHeaderCellStyling(tr: XmlEl): void {
    for (const tc of findAll(tr, "tc")) {
      const tcPr = first(tc, "tcPr");
      if (tcPr) {
        const shd = first(tcPr, "shd");
        if (shd) tcPr.removeChild(shd);
      }
      for (const run of findAll(tc, "r")) {
        const rPr = first(run, "rPr");
        if (!rPr) continue;
        for (const tag of ["b", "bCs", "color"]) {
          const el = first(rPr, tag);
          if (el) rPr.removeChild(el);
        }
      }
    }
  }

  // -- table filling ---------------------------------------------------
  private fillKvRows(tbl: XmlEl, values: Record<string, string>, skipHeader = true): void {
    const rows = this.tableRows(tbl);
    if (rows.length && this.rowCells(rows[0]).length < 2) return;
    const styleRef = this.referenceRunStyle(tbl);
    const remaining = new Map(Object.entries(values));
    const bodyRows = skipHeader ? rows.slice(1) : rows;

    for (const row of bodyRows) {
      const cells = this.rowCells(row);
      if (cells.length < 2) continue;
      const label = elText(cells[0]).trim();
      if (!label) continue;
      const labelKey = normKey(label);
      let match: string | null = null;
      for (const key of remaining.keys()) {
        const keyNorm = normKey(key);
        if (keyNorm === labelKey || labelKey.includes(keyNorm) || keyNorm.includes(labelKey)) {
          match = key;
          break;
        }
      }
      if (match !== null) {
        this.setCellText(cells[1], remaining.get(match)!, styleRef);
        remaining.delete(match);
      }
    }
  }

  fillKeyValueTable(headingText: string, values: Record<string, string>, opts: { level?: number | null; occurrence?: number } = {}): void {
    const tbl = this.tableAfter(headingText, { required: false, ...opts });
    if (!tbl) return;
    this.fillKvRows(tbl, values, true);
  }

  /** Fill a label/value cover table that sits before any heading (conventionally the first table). */
  fillCoverTable(values: Record<string, string>, tableIndex = 0): void {
    const tables = findAll(this.body, "tbl");
    if (tableIndex >= tables.length) return;
    this.fillKvRows(tables[tableIndex], values, false);
  }

  private isCaptionParagraph(pEl: XmlEl): boolean {
    const run = iterRuns(pEl)[0];
    if (!run) return false;
    const rPr = first(run, "rPr");
    if (!rPr) return false;
    const italic = first(rPr, "i");
    return !!italic && attr(italic, "val") !== "0" && attr(italic, "val") !== "false";
  }

  /**
   * Fill a single-cell "bordered box" narrative table. Some templates give
   * that cell two tiers: a small italic prompt caption (e.g. "Summary:", or
   * the section's own question restated) followed by blank paragraphs meant
   * for the answer. Filling straight into the first paragraph would make
   * the generated prose inherit the caption's italic/small styling, so when
   * that shape is detected the caption is kept and the answer is written
   * into normal body-styled paragraphs after it instead.
   */
  fillTextBox(headingText: string, text: string, opts: { level?: number | null; occurrence?: number } = {}): void {
    const tbl = this.tableAfter(headingText, { required: false, ...opts });
    if (!tbl || !text) return;
    const rows = this.tableRows(tbl);
    if (!rows.length) return;
    const cells = this.rowCells(rows[0]);
    if (!cells.length) return;
    const cell = cells[0];
    const paras = children(cell, "p");

    if (paras.length > 1 && this.isCaptionParagraph(paras[0])) {
      const caption = paras[0];
      // The template's own second paragraph is its designated "write here"
      // placeholder - sample its style before discarding it, rather than
      // falling back to the document-wide representativeRunStyle heuristic,
      // which can land on an unrelated italic line elsewhere in the doc.
      const writeInRun = iterRuns(paras[1])[0];
      const writeInRPr = writeInRun ? first(writeInRun, "rPr") : null;
      for (const p of paras.slice(1)) cell.removeChild(p);
      const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
      let anchor = caption;
      for (const block of blocks.length ? blocks : [text]) {
        const pEl = this.doc.createElementNS(W_NS, "w:p");
        const runEl = this.doc.createElementNS(W_NS, "w:r");
        if (writeInRPr) runEl.appendChild(writeInRPr.cloneNode(true));
        else if (this.representativeRunStyle) runEl.appendChild(this.representativeRunStyle.cloneNode(true));
        const t = this.doc.createElementNS(W_NS, "w:t");
        setText(t, this.doc, block);
        runEl.appendChild(t);
        pEl.appendChild(runEl);
        cell.insertBefore(pEl, anchor.nextSibling);
        anchor = pEl;
      }
      return;
    }

    const styleRef = this.referenceRunStyle(tbl);
    this.setCellText(cell, text, styleRef);
  }

  fillListTable(
    headingText: string,
    rows: Record<string, string>[],
    opts: { keepSpareRow?: boolean; level?: number | null; occurrence?: number } = {}
  ): void {
    const tbl = this.tableAfter(headingText, { required: false, level: opts.level, occurrence: opts.occurrence });
    if (!tbl || !rows.length) return;
    const tableRows = this.tableRows(tbl);
    const header = this.rowCells(tableRows[0]).map((c) => elText(c).trim());
    const styleRef = this.referenceRunStyle(tbl);
    let dataRows = tableRows.slice(1);

    rows.forEach((rowData, i) => {
      let target: XmlEl;
      let cloned = false;
      if (i < dataRows.length) {
        target = dataRows[i];
      } else {
        target = this.cloneRow(tbl);
        dataRows = this.tableRows(tbl).slice(1);
        cloned = true;
      }
      const targetCells = this.rowCells(target);
      // A cloned row starts as a copy of whatever row preceded it (there is
      // no blank template row left to reuse) - blank it out first so an
      // unset column can't leak that row's content into this one.
      if (cloned) for (const cell of targetCells) this.setCellText(cell, "", styleRef);
      header.forEach((colName, colIdx) => {
        if (colIdx >= targetCells.length) return;
        let value: string | undefined;
        if (AUTO_NUMBER_COLUMN.test(colName)) value = String(i + 1);
        else value = TemplateDoc.lookupColumn(rowData, colName);
        if (value !== undefined) this.setCellText(targetCells[colIdx], String(value), styleRef);
      });
    });

    dataRows = this.tableRows(tbl).slice(1);
    let surplus = dataRows.slice(rows.length);
    if (opts.keepSpareRow && surplus.length) surplus = surplus.slice(1);
    for (const extra of surplus) extra.parentNode.removeChild(extra);
  }

  fillListTableByKey(
    headingText: string,
    keyColumn: string,
    rows: Record<string, string>[],
    opts: { level?: number | null; occurrence?: number } = {}
  ): void {
    const tbl = this.tableAfter(headingText, { required: false, ...opts });
    if (!tbl || !rows.length) return;
    const tableRows = this.tableRows(tbl);
    const header = this.rowCells(tableRows[0]).map((c) => elText(c).trim());
    const keyIdx = header.indexOf(keyColumn);
    if (keyIdx === -1) return;
    const styleRef = this.referenceRunStyle(tbl);

    const byKey = new Map(rows.filter((r) => r[keyColumn]).map((r) => [normKey(String(r[keyColumn])), r]));

    for (const row of tableRows.slice(1)) {
      const cells = this.rowCells(row);
      if (keyIdx >= cells.length) continue;
      const existingKey = normKey(elText(cells[keyIdx]));
      const rowData = byKey.get(existingKey);
      if (!rowData) continue;
      header.forEach((colName, colIdx) => {
        if (colIdx === keyIdx || colIdx >= cells.length) return;
        const value = TemplateDoc.lookupColumn(rowData, colName);
        if (value !== undefined) this.setCellText(cells[colIdx], String(value), styleRef);
      });
    }
  }

  // -- cover page --------------------------------------------------------
  setCoverField(label: string, value: string): boolean {
    for (const p of this.allParagraphs()) {
      const text = elText(p);
      if (norm(text) === norm(label) || norm(text).startsWith(norm(label))) {
        const runs = iterRuns(p);
        if (!runs.length) return false;
        const t = first(runs[0], "t");
        if (t) setText(t, this.doc, `${label}: ${value}`);
        for (const extra of runs.slice(1)) p.removeChild(extra);
        return true;
      }
    }
    return false;
  }

  /** Swap a paragraph's entire text for something new, matched by its current (exact, normalised) content. */
  replaceText(oldText: string, newText: string, occurrence = 0): boolean {
    const target = norm(oldText);
    const matches = this.allParagraphs().filter((p) => norm(elText(p)) === target);
    if (occurrence >= matches.length) return false;
    const p = matches[occurrence];
    const runs = iterRuns(p);
    if (!runs.length) return false;
    const t = first(runs[0], "t");
    if (t) setText(t, this.doc, newText);
    for (const extra of runs.slice(1)) p.removeChild(extra);
    return true;
  }

  // -- output --------------------------------------------------------
  async save(): Promise<Buffer> {
    const xml = new XMLSerializer().serializeToString(this.doc);
    this.zip.file("word/document.xml", xml);
    return this.zip.generateAsync({ type: "nodebuffer" });
  }
}
