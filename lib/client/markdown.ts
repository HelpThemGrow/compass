// Model answers are Markdown: headings, bullet/numbered lists (nested by indentation), bold/italic, tables,
// blockquotes and [n] citations. Links and raw HTML are deliberately not supported - everything is escaped
// first, so the only tags in the output are the ones added here. Ported unchanged from public/app.js.

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function inlineMd(escaped: string): string {
  return escaped
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${part.slice(1, -1)}</code>`;
      return part
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/__(.+?)__/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(/\[(\d+(?:\s*[,;]\s*(?:\d+|(?:Section|Sec\.?|§)\s*[\w.–-]+))*)\]/g, '<sup class="cite-ref">[$1]</sup>');
    })
    .join("");
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => inlineMd(c.trim()));
}

export function renderMarkdown(src: unknown): string {
  const lines = esc(String(src ?? "").replace(/\r\n?/g, "\n")).split("\n");
  const out: string[] = [];
  const lists: { type: string; indent: number }[] = [];
  let para: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join(" "))}</p>`);
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${inlineMd(quote.join(" "))}</blockquote>`);
    quote = [];
  };
  const closeLists = (downTo = -1) => {
    while (lists.length && lists[lists.length - 1].indent > downTo) out.push(`</li></${lists.pop()!.type}>`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    const quoteLine = line.match(/^\s*&gt;\s?(.*)$/);

    if (!line.trim()) {
      flushPara();
      flushQuote();
      continue;
    }
    if (item) {
      flushPara();
      flushQuote();
      const indent = item[1].replace(/\t/g, "    ").length;
      const type = /\d/.test(item[2]) ? "ol" : "ul";
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (!top || top.indent < indent) {
        out.push(`<${type}>`);
        lists.push({ type, indent });
      } else {
        out.push("</li>");
        if (top.type !== type) {
          out.push(`</${lists.pop()!.type}><${type}>`);
          lists.push({ type, indent });
        }
      }
      out.push(`<li>${inlineMd(item[3])}`);
      continue;
    }
    if (lists.length && /^\s+\S/.test(line)) {
      out.push(` ${inlineMd(line.trim())}`);
      continue;
    }

    closeLists();
    if (heading) {
      flushPara();
      flushQuote();
      const tag = heading[1].length <= 2 ? "h4" : heading[1].length === 3 ? "h5" : "h6";
      out.push(`<${tag}>${inlineMd(heading[2])}</${tag}>`);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushQuote();
      out.push("<hr>");
    } else if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(lines[i + 1] ?? "")) {
      flushPara();
      flushQuote();
      const head = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(tableCells(lines[i++]));
      i -= 1;
      out.push(
        `<div class="overflow-x-auto"><table class="md-table"><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`
      );
    } else if (quoteLine) {
      flushPara();
      quote.push(quoteLine[1]);
    } else {
      flushQuote();
      para.push(line.trim());
    }
  }
  flushPara();
  flushQuote();
  closeLists();
  return out.join("");
}
