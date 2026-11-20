/**
 * Render an evaluation as a Markdown review memo. Port of app/report.py.
 */
const VERDICT_LABEL: Record<string, string> = {
  met: "Met",
  partially_met: "Partially met",
  not_met: "Not met",
  not_applicable: "N/A",
};

const SEVERITY_LABEL: Record<string, string> = { blocker: "Blocker", major: "Major", minor: "Minor", info: "Info" };

function bar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toMarkdown(ev: any): string {
  const lines: string[] = [];
  const add = (s: string) => lines.push(s);

  add(`# Framework Review — ${ev.filename}`);
  add("");
  add(`**Rubric:** ${ev.rubric_name} v${ev.rubric_version}  `);
  add(`**Reviewed:** ${ev.created_at}  `);
  add(`**Report ID:** \`${ev.id}\``);
  add("");
  add("---");
  add("");
  add(`## Result: ${ev.overall_score}/100 — ${ev.band}`);
  add("");
  add(`> ${ev.band_note}`);
  add("");
  add(`- Content against framework criteria: **${ev.content_score}/100**`);
  add(`- Structural completeness: **${ev.structure_score}/100**`);
  if (ev.capped_reason) add(`- **Score capped.** ${ev.capped_reason}`);
  add("");

  const summary = ev.summary ?? {};
  if (summary.overall_summary) {
    add("### Summary");
    add("");
    add(summary.overall_summary);
    add("");
  }

  if (summary.strengths?.length) {
    add("### What is working");
    add("");
    for (const item of summary.strengths) add(`- ${item}`);
    add("");
  }

  const actions = summary.priority_actions ?? [];
  if (actions.length) {
    add("### Priority actions");
    add("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions.forEach((action: any, i: number) => {
      const ids = (action.criterion_ids ?? []).join(", ");
      const suffix = ids ? ` _(resolves ${ids})_` : "";
      add(
        `${i + 1}. **${(action.action ?? "").trim()}** — ${(action.why_it_matters ?? "").trim()} ` +
          `\`effort: ${action.effort ?? "medium"}\`${suffix}`
      );
    });
    add("");
  }

  add("---");
  add("");
  add("## Dimension scores");
  add("");
  add("| Dimension | Weight | Score |");
  add("|---|---|---|");
  for (const dim of ev.dimensions ?? []) {
    add(`| ${dim.name} | ${dim.weight} | \`${bar(dim.score)}\` ${dim.score}/100 |`);
  }
  add("");

  const det = ev.deterministic ?? {};
  const failures = (det.findings ?? []).filter((f: { status: string }) => f.status !== "pass");
  add("## Structural checks");
  add("");
  add(
    `Word count: ${(det.word_count ?? 0).toLocaleString()}. ` +
      `Sections found: ${(det.present_sections ?? []).length}. ` +
      `Sections missing: ${(det.missing_sections ?? []).length}.`
  );
  add("");
  if (failures.length) {
    add("| Severity | Check | Detail | Fix |");
    add("|---|---|---|---|");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const f of failures as any[]) {
      add(`| ${SEVERITY_LABEL[f.severity] ?? f.severity} | ${clean(f.title)} | ${clean(f.detail)} | ${clean(f.remedy)} |`);
    }
  } else {
    add("All structural checks passed.");
  }
  add("");

  add("---");
  add("");
  add("## Criterion-by-criterion findings");
  add("");
  for (const dim of ev.dimensions ?? []) {
    add(`### ${dim.name} — ${dim.score}/100`);
    add("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of dim.criteria ?? ([] as any[])) {
      add(
        `**${c.id} — ${c.score}/4 · ${VERDICT_LABEL[c.verdict] ?? c.verdict}** (confidence: ${c.confidence ?? "low"})`
      );
      add("");
      add(`*Requirement:* ${c.requirement}`);
      add("");
      if (c.evidence_verified === false) {
        add("> **Unverified.** The quote cited for this criterion could not be located in the document. Check this score by hand.");
      } else if (c.evidence_quote) {
        add(`> ${c.evidence_quote}`);
        if (c.evidence_location) add(`>\n> — ${c.evidence_location}`);
      } else {
        add("> No supporting evidence found in the document.");
      }
      add("");
      if (c.gap) {
        add(`*Gap:* ${c.gap}`);
        add("");
      }
      if (c.recommended_fix) {
        add(`*Fix:* ${c.recommended_fix}`);
        add("");
      }
      if (c.framework_refs?.length) {
        add(`*Framework reference:* ${c.framework_refs.join("; ")}`);
        add("");
      }
    }
    add("");
  }

  if (summary.reviewer_note) {
    add("---");
    add("");
    add(`**Note to reviewers:** ${summary.reviewer_note}`);
    add("");
  }

  if (ev.warnings?.length) {
    add("---");
    add("");
    add("### Caveats");
    add("");
    for (const w of ev.warnings) add(`- ${w}`);
    add("");
  }

  const stats = ev.stats ?? {};
  add("---");
  add("");
  add(
    `_Generated in ${stats.elapsed_s ?? "?"}s using ${stats.api_calls ?? 0} model call(s). ` +
      `This is an automated pre-check against the written framework; it does not replace review ` +
      `by the programme committee._`
  );

  return lines.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function filenameFor(ev: any): string {
  const stem = String(ev.filename ?? "document").split(".").slice(0, -1).join(".") || String(ev.filename ?? "document");
  const safe = [...stem].map((ch) => (/[A-Za-z0-9\-_ ]/.test(ch) ? ch : "_")).join("").trim() || "review";
  return `review_${safe}_${ev.id ?? ""}.md`;
}
