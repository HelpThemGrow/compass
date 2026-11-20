/**
 * Local screening for personal and confidential data.
 *
 * Vibha's data policy rules out uploading child/student records, government
 * IDs, payment data and credentials. Text that reaches Ask, Verify or
 * Generate (and anything in the knowledge base) can be sent to NVIDIA's
 * hosted model, so it is screened here first - on this server, with plain
 * pattern checks, so the screening itself never sends the data anywhere.
 *
 * "block" findings stop the action; "warn" findings let it through with a
 * notice. Matched values are never returned or logged - only counts.
 *
 * This is a safety net, not a guarantee: it cannot recognise a child's name
 * on its own, or data it has no pattern for. Staff remain responsible for
 * using anonymised or aggregated data.
 */

/** Bump when the rules change, so knowledge base files indexed earlier are screened again. */
export const SCREEN_VERSION = 2;

export type Severity = "block" | "warn";

export interface SensitiveFinding {
  kind: string;
  severity: Severity;
  count: number;
  label: string;
}

// --------------------------------------------------------------------------
// Checksums - keep random numbers from looking like IDs.
// --------------------------------------------------------------------------
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Aadhaar numbers carry a Verhoeff check digit. */
function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(rev[i])]];
  return c === 0;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Card-number prefixes and lengths (Visa, Mastercard, Amex, RuPay, Diners, Discover). */
function plausibleCard(digits: string): boolean {
  const n = digits.length;
  if (/^(\d)\1+$/.test(digits)) return false;
  if (/^4/.test(digits)) return [13, 16, 19].includes(n);
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return n === 16;
  if (/^3[47]/.test(digits)) return n === 15;
  if (/^(60|65|81|82|508|6011)/.test(digits)) return n >= 16 && n <= 19;
  if (/^(35|62|50|5[6-8]|63|67)/.test(digits)) return n >= 16 && n <= 19; // JCB, UnionPay, Maestro
  if (/^3(0[0-5]|[68])/.test(digits)) return n === 14;
  return false;
}

// --------------------------------------------------------------------------
// Patterns
// --------------------------------------------------------------------------
// Aadhaar: 12 digits, first 2-9, written "1234 5678 9012" (or with - . /) or run together.
const AADHAAR = /(?<![\d+])[2-9]\d{3}([ .\/-]?)\d{4}\1\d{4}(?!\d)/g;
// Common spellings (Aadhaar, Aadhar, Adhar, Adhaar) and the Hindi word.
const AADHAAR_WORD = /\ba{1,2}dh?a{1,2}r\b|आधार|\buidai\b|\buid\b/i;
// Cards: run together, or in the usual 4-4-4-4(-3) / Amex 4-6-5 groups.
const CARD = /(?<![\d+])(?:\d{13,19}|\d{4}([ .\/-])\d{4}\1\d{4}\1\d{1,7}|\d{4}([ .\/-])\d{6}\2\d{5})(?!\d)/g;
const YEAR = /^(?:19|20)\d\d$/;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  /\bnvapi-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];
// "password: X" counts only when X looks like a secret (letters and digits, no spaces),
// so policy wording such as "Password: minimum 12 characters" is not flagged.
// Also catches DB_PASSWORD=..., "apiKey": "...", "password is ...", and "Password | value" table rows.
const SECRET_ASSIGNMENT =
  /(?:password|passwd|pwd|api[ _-]?key|secret[ _-]?key|access[ _-]?token|client[ _-]?secret)["']?\s*(?:[:=|]|\bis\b)\s*["']?([^\s"'|,;]{8,})/gi;
const MOBILE = /(?<!\d)(?:\+91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?!\d)/g;
// Bounded parts and a lookbehind keep this linear on long runs of dots and hyphens.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;
// PAN: the fourth letter is P for an individual (C company, T trust, ...).
const PERSONAL_PAN = /\b[A-Z]{3}P[A-Z]\d{4}[A-Z]\b/g;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;

// Column headings that identify a child or describe them personally.
// Headings are compared after normaliseHeader(): lower case, "(M/F)"-style notes and . : * _ # removed.
const PERSON = "(?:student|child|children|pupil|learner|beneficiary|candidate|participant)";
const NAME_COLUMN = new RegExp(`^(?:(?:${PERSON}'?s?\\s*)?(?:full\\s*)?name|name of (?:the )?${PERSON})$|नाम`);
const IDENTIFYING_COLUMNS: [string, RegExp][] = [
  ["date of birth", /\b(?:date of birth|d ?o ?b|birth ?date)\b|जन्म/],
  ["age", /^age\b|आयु|उम्र/],
  ["class", /^(?:class|grade|std|standard|section)\b|कक्षा/],
  ["gender", /^(?:gender|sex)\b|लिंग/],
  ["school ID", /\b(?:roll|adm|admission|enrol?ment|student'?s?|scholar|sr)\s*(?:no|number|id)\b|\bapaar\b|^pen\b/],
  ["parent/guardian", /\b(?:guardian|parent|father|mother)(?:'?s)?\b|पिता|माता|अभिभावक/],
  ["contact details", /\b(?:mobile|mob|phone|contact)\s*(?:no|number)?$|\baddress\b|पता/],
  ["caste/religion/health", /\b(?:caste|category|religion|disabilit(?:y|ies)|cwsn|diagnosis|medical|health|blood group)\b|जाति|धर्म/],
  ["Aadhaar", AADHAAR_WORD],
];
const MIN_ROSTER_ROWS = 5;

function distinct(text: string, pattern: RegExp, keep: (m: RegExpExecArray) => string | null = (m) => m[0]): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(pattern)) {
    const v = keep(m);
    if (v) seen.add(v.replace(/[\s-]/g, ""));
  }
  return seen.size;
}

/** Same text with Indian-script and full-width digits as 0-9 and odd spaces as plain spaces, so IDs written that way still match. */
const DIGIT_ZEROS = [0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66];
function normaliseForScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g, (ch) => {
      const code = ch.charCodeAt(0);
      const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9)!;
      return String(code - zero);
    })
    .replace(/[  -​  　]/g, " ")
    .replace(/(\d)[ ]{2,}(?=\d)/g, "$1 ");
}

const CELL_SEPARATOR = /[|\t]/;

function normaliseHeader(cell: string): string {
  return cell.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[.:*_#]/g, " ").replace(/\s+/g, " ").trim();
}

function cellsOf(line: string): string[] {
  const cells = line.split(CELL_SEPARATOR).map((c) => c.trim());
  if (cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * Find tables of children's personal records: a name column plus at least
 * two kinds of identifying column, followed by MIN_ROSTER_ROWS or more rows.
 * Extraction renders Word/Excel/CSV tables (and Markdown tables) as
 * "a | b | c" lines, so this works the same for every file type.
 */
function rosterTables(text: string): { rows: number; columns: string[] }[] {
  const lines = text.split("\n");
  const found: { rows: number; columns: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CELL_SEPARATOR.test(lines[i])) continue;
    const header = cellsOf(lines[i]).map(normaliseHeader);
    if (!header.some((c) => NAME_COLUMN.test(c))) continue;
    const kinds = IDENTIFYING_COLUMNS.filter(([, re]) => header.some((c) => re.test(c))).map(([k]) => k);
    if (kinds.length < 2) continue;
    let rows = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue; // Word tables come out with a blank line between rows
      if (!CELL_SEPARATOR.test(line) || line.startsWith("# Sheet:") || line.startsWith("[TABLE") || line === "[/TABLE]") break;
      if (/^\|?\s*:?-{3,}/.test(line)) continue; // Markdown divider
      if (cellsOf(line).filter(Boolean).length >= 2) rows++;
    }
    if (rows >= MIN_ROSTER_ROWS) found.push({ rows, columns: kinds });
  }
  return found;
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------
export function scanText(raw: string): SensitiveFinding[] {
  const text = normaliseForScan(raw);
  const findings: SensitiveFinding[] = [];
  const add = (kind: string, severity: Severity, count: number, label: string) => {
    if (count > 0) findings.push({ kind, severity, count, label });
  };

  // One in ten random 12-digit numbers passes the checksum, so a lone run-together
  // number counts only when the text talks about Aadhaar or has several of them.
  let grouped = false;
  const aadhaar = distinct(text, AADHAAR, (m) => {
    if (!verhoeffValid(m[0].replace(/\D/g, ""))) return null;
    if (m[1]) {
      if (m[0].split(m[1]).every((g) => YEAR.test(g))) return null; // "2019 2020 2021"
      grouped = true;
    }
    return m[0];
  });
  if (grouped || aadhaar >= 3 || (aadhaar && AADHAAR_WORD.test(text))) add("aadhaar", "block", aadhaar, "Aadhaar number(s)");
  add(
    "payment_card",
    "block",
    distinct(text, CARD, (m) => {
      const d = m[0].replace(/\D/g, "");
      return luhnValid(d) && plausibleCard(d) ? d : null;
    }),
    "payment card number(s)"
  );
  const secrets =
    SECRET_PATTERNS.reduce((n, re) => n + distinct(text, re), 0) +
    distinct(text, SECRET_ASSIGNMENT, (m) => (/[A-Za-z]/.test(m[1]) && /\d/.test(m[1]) ? m[1] : null));
  add("credentials", "block", secrets, "password(s), API key(s) or private key(s)");
  add("personal_pan", "block", distinct(text, PERSONAL_PAN), "personal PAN number(s)");
  for (const t of rosterTables(text)) {
    add("child_records", "block", t.rows, `rows in a table of personal records (columns: name, ${t.columns.join(", ")})`);
  }

  const phones = distinct(text, MOBILE);
  if (phones >= 3) add("phone_numbers", "warn", phones, "mobile phone numbers");
  const emails = distinct(text, EMAIL, (m) => m[0].toLowerCase());
  if (emails >= 10) add("email_addresses", "warn", emails, "email addresses");
  add("bank_codes", "warn", distinct(text, IFSC), "bank IFSC code(s)");
  return findings;
}

export const blocking = (f: SensitiveFinding[]) => f.filter((x) => x.severity === "block");
export const warnings = (f: SensitiveFinding[]) => f.filter((x) => x.severity === "warn");

export function warningMessage(what: string, findings: SensitiveFinding[]): string {
  return `${what} contains ${describe(warnings(findings))}. Check that it is meant to be shared before relying on it.`;
}

export function describe(findings: SensitiveFinding[]): string {
  return findings.map((f) => `${f.count} ${f.label}`).join("; ");
}

/** Human message for a blocked action. */
export function blockedMessage(what: string, findings: SensitiveFinding[]): string {
  return (
    `${what} appears to contain ${describe(blocking(findings))}. ` +
    "Vibha's data policy does not allow children's records, government IDs, payment details or credentials " +
    "to be used with this tool. Remove or anonymise them and try again."
  );
}
