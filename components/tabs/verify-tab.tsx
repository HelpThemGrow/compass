"use client";

import * as React from "react";
import { CopyIcon, DownloadIcon, PlayIcon, UploadCloudIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import {
  bandTone,
  isAbort,
  streamJob,
  isStructuralOnly,
  severityTone,
  stripMd,
  type Criterion,
  type Evaluation,
  type Progress,
  type Tone,
} from "@/lib/client/api";
import { useElapsed } from "@/lib/client/use-elapsed";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Section } from "@/components/ui/section";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { JobProgress } from "@/components/common/job-progress";
import { PageHeader } from "@/components/common/page-header";
import { StatusBadge } from "@/components/common/status-badge";

const VERDICTS: Record<string, [string, Tone]> = {
  met: ["Met", "success"],
  partially_met: ["Partially met", "warning"],
  not_met: ["Not met", "destructive"],
  not_applicable: ["Not applicable", "info"],
};

const TONE_STROKE: Record<string, string> = {
  success: "stroke-success",
  info: "stroke-primary",
  warning: "stroke-warning",
  destructive: "stroke-destructive",
  muted: "stroke-muted-foreground",
};
const TONE_BAR: Record<string, string> = {
  success: "bg-success",
  info: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};

function Dial({ score, neutral }: { score: number; neutral: boolean }) {
  const r = 56;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const stroke = neutral ? TONE_STROKE.muted : TONE_STROKE[bandTone(score)];
  return (
    <div className="relative size-32 flex-none">
      <svg width="132" height="132" viewBox="0 0 132 132" className="-rotate-90">
        <circle cx="66" cy="66" r={r} fill="none" strokeWidth="11" className="stroke-muted" />
        <circle
          cx="66"
          cy="66"
          r={r}
          fill="none"
          strokeWidth="11"
          strokeLinecap="round"
          strokeDasharray={`${(c * pct).toFixed(1)} ${c.toFixed(1)}`}
          className={stroke}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <b className="tabular text-3xl leading-none font-semibold tracking-tight">{score}</b>
        <span className="text-[11px] text-muted-foreground">out of 100</span>
      </div>
    </div>
  );
}

function CriterionRow({ c, structural }: { c: Criterion; structural: boolean }) {
  // A structural-only run never judged content: every criterion carries the same fallback score=0/verdict=not_met,
  // which would otherwise look identical to a document that was judged and failed everything.
  const [label, tone] = structural ? (["Not assessed", "info"] as [string, Tone]) : VERDICTS[c.verdict] || (["Unknown", "info"] as [string, Tone]);
  const na = structural || c.verdict === "not_applicable";
  const pillText = structural ? "—" : c.verdict === "not_applicable" ? "n/a" : `${c.score}/4`;
  const pillTone: Tone = na ? "muted" : c.score >= 3 ? "success" : c.score === 2 ? "warning" : "destructive";
  return (
    <div className="border-t py-3 first:border-t-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <code className="rounded-md bg-muted px-1 py-0.5 font-mono text-xs">{c.id}</code>
        <Badge variant={pillTone} className="tabular">
          {pillText}
        </Badge>
        <StatusBadge tone={tone} label={label} />
        {!structural && <span className="text-xs text-muted-foreground">confidence: {c.confidence}</span>}
      </div>
      <div className="mb-2 text-[13px] text-muted-foreground">{c.requirement}</div>
      {c.evidence_verified === false ? (
        <blockquote className="my-2 rounded-r-md border-l-[3px] bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
          <i>The quote cited for this criterion could not be located in the document. This score is unverified — check it by hand.</i>
        </blockquote>
      ) : c.evidence_quote ? (
        <blockquote className="my-2 rounded-r-md border-l-[3px] bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
          {c.evidence_quote}
          {c.evidence_location && <cite className="mt-1 block text-[11px] not-italic">found in: {stripMd(c.evidence_location)}</cite>}
        </blockquote>
      ) : (
        <blockquote className="my-2 rounded-r-md border-l-[3px] bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
          <i>No supporting evidence found in the document.</i>
        </blockquote>
      )}
      {c.gap && (
        <div className="my-1 text-[13px]">
          <b className="font-medium">Gap:</b> {c.gap}
        </div>
      )}
      {c.recommended_fix && (
        <div className="my-1 text-[13px]">
          <b className="font-medium">Fix:</b> {c.recommended_fix}
        </div>
      )}
      {(c.framework_refs || []).length > 0 && (
        <div className="mt-1 text-xs text-muted-foreground">Framework: {c.framework_refs!.map(stripMd).join("; ")}</div>
      )}
    </div>
  );
}

function Result({ r, onReassess }: { r: Evaluation; onReassess: () => void }) {
  const s = r.summary || {};
  const det = r.deterministic || {};
  const failures = (det.findings || []).filter((f) => f.status !== "pass");
  const structural = isStructuralOnly(r);
  const dims = React.useMemo(() => r.dimensions || [], [r.dimensions]);

  const defaults = React.useMemo(
    () => dims.map((d) => d.criteria.filter((c) => c.score < 3 && c.verdict !== "not_applicable").length > 0 && !structural),
    [dims, structural]
  );
  const [open, setOpen] = React.useState<boolean[]>(defaults);
  React.useEffect(() => setOpen(defaults), [defaults]);
  const allOpen = open.length > 0 && open.every(Boolean);
  const [onlyIssues, setOnlyIssues] = React.useState(false);
  const needsWork = (c: Criterion) => c.score < 3 && c.verdict !== "not_applicable";
  const copySummary = async () => {
    const lines = [
      `${r.filename} — ${r.overall_score}/100 (${r.band})`,
      s.overall_summary ?? "",
      ...(s.priority_actions ?? []).map((a, i) => `${i + 1}. ${a.action} — ${a.why_it_matters}`),
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success("Summary copied.");
    } catch {
      toast.error("Could not copy to the clipboard.");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-6">
          <Dial score={r.overall_score} neutral={structural} />
          <div className="min-w-60 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h2 className="m-0 text-base font-semibold">{r.filename}</h2>
              <StatusBadge tone={structural ? "info" : bandTone(r.overall_score)} label={r.band} />
            </div>
            <p className="mb-1 text-muted-foreground">{r.band_note}</p>
            <div className="text-xs text-muted-foreground">
              Assessed against <b>{r.rubric_name}</b> v{r.rubric_version} {r.auto_selected ? "(detected automatically)" : ""} · {r.created_at}
            </div>
            <div className="mt-2 flex flex-wrap gap-6 text-xs text-muted-foreground">
              <div>
                Framework criteria
                <br />
                <b className="tabular text-sm text-foreground">{r.content_score}</b>/100
              </div>
              <div>
                Structural completeness
                <br />
                <b className="tabular text-sm text-foreground">{r.structure_score}</b>/100
              </div>
              <div>
                Words
                <br />
                <b className="tabular text-sm text-foreground">{(det.word_count || 0).toLocaleString()}</b>
              </div>
              <div>
                Model calls used
                <br />
                <b className="tabular text-sm text-foreground">{r.stats?.api_calls ?? 0}</b>
              </div>
            </div>
          </div>
        </div>
        {r.capped_reason && (
          <Notice tone="destructive">
            <b>Rating capped.</b> {r.capped_reason}
          </Notice>
        )}
        {r.auto_selected && r.rubric_suggestions?.[0]?.close_call && (
          <Notice>
            <b>Rubric detection was not clear-cut.</b> This was assessed as <b>{r.rubric_name}</b>, but it also resembles{" "}
            {r.rubric_suggestions[1]?.name || "another document type"}. If that is the wrong standard, choose the rubric explicitly above and run it again.
          </Notice>
        )}
        {(r.warnings || []).map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/evaluations/${encodeURIComponent(r.id)}/markdown`}>
              <DownloadIcon className="stroke-[1.5]" /> Download review memo
            </a>
          </Button>
          <Button variant="outline" size="sm" onClick={copySummary}>
            <CopyIcon className="stroke-[1.5]" /> Copy summary
          </Button>
          {(r.rubric_suggestions || []).length > 1 && (
            <Button variant="ghost" size="sm" onClick={onReassess}>
              Reassess with a different rubric
            </Button>
          )}
        </div>
      </Card>

      {s.overall_summary && (
        <Card className="gap-3 p-4">
          <h2 className="m-0 text-base font-semibold">Summary</h2>
          <p className="mb-0 text-muted-foreground">{s.overall_summary}</p>
          {(s.strengths || []).length > 0 && (
            <>
              <h3 className="mt-1 text-sm font-semibold">What is working</h3>
              <ul className="m-0 list-disc space-y-1 pl-5">
                {s.strengths!.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}
          {(s.priority_actions || []).length > 0 && (
            <>
              <h3 className="mt-1 text-sm font-semibold">Do these first</h3>
              <ol className="m-0 grid list-none gap-2 p-0">
                {s.priority_actions!.map((a, i) => (
                  <li key={i} className="flex gap-3 rounded-md border bg-muted/40 px-3 py-2 text-[13px]">
                    <span className="tabular mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                      {i + 1}
                    </span>
                    <div>
                      <b>{a.action}</b>
                      <span className="mt-1 block text-xs text-muted-foreground">{a.why_it_matters}</span>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <Badge variant="muted">effort: {a.effort || "medium"}</Badge>
                        {(a.criterion_ids || []).map((id) => (
                          <Badge key={id} variant="muted" className="font-mono">
                            {id}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
          {s.reviewer_note && (
            <Notice tone="info">
              <b>For the reviewing committee:</b> {s.reviewer_note}
            </Notice>
          )}
        </Card>
      )}

      {dims.length > 0 && (
        <Card className="gap-3 p-4">
          <h2 className="m-0 text-base font-semibold">Scores by dimension</h2>
          {structural && <p className="mb-0 text-xs text-muted-foreground">Content was not scored, so these are not real dimension results.</p>}
          <div className="grid gap-2">
            {dims.map((d) => (
              <div key={d.name} className="grid grid-cols-[minmax(160px,1.6fr)_1fr_48px] items-center gap-3 text-[13px]">
                <span>
                  {d.name} <span className="text-xs text-muted-foreground">· weight {d.weight}</span>
                </span>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", structural ? TONE_BAR.info : TONE_BAR[bandTone(d.score)])}
                    style={{ width: `${structural ? 0 : d.score}%` }}
                  />
                </div>
                <span className="tabular text-right text-xs text-muted-foreground">{structural ? "—" : d.score}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="gap-3 p-4">
        <h2 className="m-0 text-base font-semibold">Structural checks</h2>
        <p className="mb-0 text-xs text-muted-foreground">Run by parsing the document. No model involved, so these results are identical every time.</p>
        {(det.missing_sections || []).length > 0 && (
          <Notice tone="destructive">
            <b>Missing required sections:</b> {det.missing_sections!.join(", ")}
          </Notice>
        )}
        {failures.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severity</TableHead>
                <TableHead>Check</TableHead>
                <TableHead>Finding</TableHead>
                <TableHead>Fix</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failures.map((f, i) => (
                <TableRow key={i}>
                  <TableCell className="h-auto py-2 align-top">
                    <Badge variant={severityTone(f.severity)}>{f.severity}</Badge>
                  </TableCell>
                  <TableCell className="h-auto py-2 align-top whitespace-normal">{f.title}</TableCell>
                  <TableCell className="h-auto py-2 align-top whitespace-normal">{f.detail}</TableCell>
                  <TableCell className="h-auto py-2 align-top whitespace-normal">{f.remedy}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="mb-0 text-muted-foreground">All structural checks passed.</p>
        )}
      </Card>

      {dims.length > 0 && (
        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-base font-semibold">Criterion-by-criterion findings</h2>
            <div className="flex items-center gap-2">
              {!structural && (
                <div role="group" aria-label="Filter criteria" className="flex rounded-md border p-0.5">
                  {(
                    [
                      [false, "All"],
                      [true, "Needs attention"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={onlyIssues === v}
                      onClick={() => setOnlyIssues(v)}
                      className={cn(
                        "h-5 rounded px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        onlyIssues === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <Button variant="outline" size="xs" onClick={() => setOpen(dims.map(() => !allOpen))}>
                {allOpen ? "Collapse all" : "Expand all"}
              </Button>
            </div>
          </div>
          {dims.map((d, i) => {
            const weak = d.criteria.filter((c) => c.score < 3 && c.verdict !== "not_applicable").length;
            return (
              <Section
                key={d.name}
                title={d.name}
                open={open[i] ?? false}
                onToggle={(o) => setOpen((prev) => prev.map((v, j) => (j === i ? o : v)))}
                aside={
                  <>
                    {structural ? (
                      <Badge variant="info">not scored</Badge>
                    ) : weak ? (
                      <Badge variant="destructive">{weak} to address</Badge>
                    ) : (
                      <Badge variant="success">clear</Badge>
                    )}
                    <Badge variant={structural ? "info" : bandTone(d.score)} className="tabular">
                      {structural ? "—" : `${d.score}/100`}
                    </Badge>
                  </>
                }
              >
                {d.criteria
                  .filter((c) => !onlyIssues || structural || needsWork(c))
                  .map((c) => (
                    <CriterionRow key={c.id} c={c} structural={structural} />
                  ))}
              </Section>
            );
          })}
        </Card>
      )}
    </div>
  );
}

const PREFS_KEY = "compass-verify-prefs";
const ACCEPT = [".pdf", ".docx", ".txt", ".md", ".markdown", ".xlsx", ".csv"];
const MAX_BYTES = 25 * 1024 * 1024;

export function VerifyTab({ result, onResult }: { result: Evaluation | null; onResult: (r: Evaluation | null) => void }) {
  const { rubrics } = useApp();
  const [file, setFile] = React.useState<File | null>(null);
  const [rubricId, setRubricId] = React.useState("auto");
  const [evidence, setEvidence] = React.useState("2");
  const [skipLlm, setSkipLlm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [completed, setCompleted] = React.useState<string[]>([]);
  const abort = React.useRef<AbortController | null>(null);
  const prefsLoaded = React.useRef(false);
  const elapsed = useElapsed(busy);
  const [error, setError] = React.useState<string | null>(null);
  const [over, setOver] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const rubricSelect = React.useRef<HTMLSelectElement>(null);
  const uploadPanel = React.useRef<HTMLDivElement>(null);
  const resultRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  // Remember the last choices (browser storage may be unavailable).
  React.useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (typeof p.rubricId === "string") setRubricId(p.rubricId);
      if (typeof p.evidence === "string") setEvidence(p.evidence);
      if (typeof p.skipLlm === "boolean") setSkipLlm(p.skipLlm);
    } catch {
      /* ignore */
    }
    prefsLoaded.current = true;
  }, []);
  React.useEffect(() => {
    if (!prefsLoaded.current) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ rubricId, evidence, skipLlm }));
    } catch {
      /* ignore */
    }
  }, [rubricId, evidence, skipLlm]);

  function pick(f: File | undefined) {
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPT.includes(ext)) {
      toast.error(`${ext || "That file type"} is not supported. Use PDF, Word, Markdown, text, Excel or CSV.`);
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error("That file is over 25 MB.");
      return;
    }
    setFile(f);
    setError(null);
  }

  async function run() {
    if (!file || busy) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError(null);
    setCompleted([]);
    setProgress(null);
    onResult(null);

    const body = new FormData();
    body.append("file", file);
    body.append("rubric_id", rubricId);
    body.append("skip_llm", skipLlm ? "true" : "false");
    body.append("evidence_per_criterion", evidence);
    try {
      onResult(
        await streamJob<Evaluation>(
          "/api/verify?stream=1",
          { method: "POST", body },
          {
            signal: ctrl.signal,
            onProgress: (p) => {
              setProgress(p);
              setCompleted((c) => [...c, p.message]);
            },
          }
        )
      );
    } catch (err) {
      if (isAbort(err)) toast.message("Review cancelled.");
      else setError((err as Error).message);
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Check a document against the framework"
      />

      <Card ref={uploadPanel} className="gap-3 p-4">
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          accept=".pdf,.docx,.txt,.md,.markdown,.xlsx,.csv"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            pick(e.dataTransfer.files[0]);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed border-input bg-muted/40 px-4 py-8 text-center outline-none transition-colors hover:border-primary hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
            over && "border-primary bg-accent"
          )}
        >
          <UploadCloudIcon className="size-6 stroke-[1.5] text-muted-foreground" aria-hidden="true" />
          <strong className="font-medium">Drop a file here, or click to choose</strong>
          <span className="text-xs text-muted-foreground">PDF, Word, Markdown, text, Excel or CSV · up to 25&nbsp;MB</span>
          {file && (
            <div className="mt-1 flex items-center gap-2 rounded-md border bg-card px-2 py-1 font-medium text-primary" onClick={(e) => e.stopPropagation()}>
              {file.name} · {(file.size / 1024).toFixed(0)} KB
              <Button variant="ghost" size="icon-xs" aria-label="Remove file" disabled={busy} onClick={() => setFile(null)}>
                <XIcon className="stroke-[1.5]" />
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-52 gap-1.5">
            <Label htmlFor="rubric">Assess against</Label>
            <NativeSelect id="rubric" ref={rubricSelect} value={rubricId} onChange={(e) => setRubricId(e.target.value)}>
              <option value="auto">Detect automatically</option>
              {rubrics.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} (v{r.version})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid min-w-52 gap-1.5">
            <Label htmlFor="evidence">Evidence passages per criterion</Label>
            <NativeSelect id="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)}>
              <option value="2">2 — fastest</option>
              <option value="3">3 — balanced</option>
              <option value="5">5 — most thorough</option>
            </NativeSelect>
          </div>
          <label className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" className="size-4 accent-primary" checked={skipLlm} onChange={(e) => setSkipLlm(e.target.checked)} />
            Structural checks only (no model calls)
          </label>
          <Button onClick={run} disabled={!file || busy}>
            <PlayIcon className="stroke-[1.5]" /> Run review
          </Button>
        </div>

        {busy && (
          <JobProgress
            current={progress ? `${progress.message} (${progress.done} of ${progress.total})` : skipLlm ? "Running structural checks…" : "Reading the document and gathering evidence…"}
            completed={completed}
            progress={progress}
            elapsed={elapsed}
            onCancel={() => abort.current?.abort()}
          />
        )}
      </Card>

      <div ref={resultRef} className="flex flex-col gap-3">
        {error && (
          <Card className="gap-0 p-3">
            <Notice tone="destructive">
              <b>Review failed.</b>
              <br />
              {error}
            </Notice>
          </Card>
        )}
        {result && (
          <Result
            r={result}
            onReassess={() => {
              rubricSelect.current?.focus();
              uploadPanel.current?.scrollIntoView({ behavior: "smooth" });
            }}
          />
        )}
      </div>
    </div>
  );
}
