"use client";

import * as React from "react";
import { CheckIcon, CopyIcon, DownloadIcon, FilePenLineIcon, RefreshCwIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { api, isAbort, streamJob, type Progress } from "@/lib/client/api";
import { useElapsed } from "@/lib/client/use-elapsed";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Section } from "@/components/ui/section";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { JobProgress } from "@/components/common/job-progress";
import { PageHeader } from "@/components/common/page-header";

interface Block {
  kind: string;
  heading: string;
  fields?: string[];
  columns?: string[];
}
interface Generated {
  id: string;
  doc_name: string;
  created_at: string;
  warnings?: string[];
  stats?: { api_calls?: number; elapsed_s?: number };
  blocks?: Record<string, Block>;
  content?: Record<string, unknown>;
}
interface HistoryRow {
  id: string;
  doc_name: string;
  description?: string;
  created_at: string;
}

const MIN = 20;
const MAX = 8000;
const DRAFT_KEY = "compass-generate-description";

const EXAMPLES = [
  {
    label: "Foundational literacy",
    text: "A foundational literacy programme in 40 government primary schools in Sundarpur block, Grades 1-3, reaching about 6,000 children over 18 months starting April 2027. A Learning Facilitator runs daily 45-minute reading sessions per cluster of 5 schools, with monthly coaching for 120 teachers and quarterly review meetings with the Block Education Officer. Baseline shows 20% of Grade 3 children reading a Grade 2 text; the target is 50% by the end of the programme. Total budget is about INR 1.2 crore, of which 70% is programme delivery, 20% staff and 10% administration. Implementing partner is Shiksha Vikas Samiti, a registered trust with 8 years of experience. Main risks are teacher transfers and school closures during harvest.",
  },
  {
    label: "Numeracy support",
    text: "A numeracy support programme for Grades 4-5 in 25 government upper-primary schools in Bhadrak district, Odisha, reaching around 3,500 children over 12 months. Trained community volunteers run weekly maths activity sessions, and teachers get two training workshops. Baseline: 35% of Grade 5 children can do basic division. Target: 55%. Budget is roughly INR 65 lakh. Partner organisation and timeline are not yet confirmed.",
  },
  {
    label: "Teacher training",
    text: "A teacher capacity-building programme for 300 government secondary school teachers across 3 blocks in Raichur district, Karnataka, over 24 months. It has four 5-day in-person training modules, school-based mentoring visits every 6 weeks, and an online resource library. Success measures are a 25% improvement in classroom observation scores and a 10-point gain in Grade 9 science assessment results. A district steering committee meets quarterly, with the State Council of Educational Research and Training as the government counterpart. Budget is INR 2.4 crore, with 15% co-funded by the state government. Risks include teacher attendance and delays in government approvals.",
  },
];

// ---- rendering and export helpers (work for every block kind, not just three) ----------------------------
type Row = Record<string, unknown>;
const isRows = (v: unknown): v is Row[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "object" && x !== null);
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.values(value as object).every((x) => x === "" || x === null || x === undefined);
  return false;
}

function BlockBody({ block, value }: { block: Block; value: unknown }) {
  if (typeof value === "string") return <p className="mb-0 whitespace-pre-line">{value}</p>;
  if (Array.isArray(value) && !isRows(value)) {
    return (
      <ul className="m-0 list-disc space-y-1 pl-5">
        {value.map((item, i) => (
          <li key={i}>{text(item)}</li>
        ))}
      </ul>
    );
  }
  if (isRows(value)) {
    const cols = block.columns?.length ? block.columns : Object.keys(value[0]);
    return (
      <Table>
        <TableHeader>
          <TableRow>
            {cols.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {value.map((row, i) => (
            <TableRow key={i}>
              {cols.map((c) => (
                <TableCell key={c} className="h-auto py-2 align-top whitespace-normal">
                  {text(row[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  if (typeof value === "object" && value) {
    const v = value as Row;
    const keys = (block.fields?.length ? block.fields : Object.keys(v)).filter((k) => !isEmpty(v[k]));
    return (
      <Table>
        <TableBody>
          {keys.map((k) => (
            <TableRow key={k}>
              <TableHead className="whitespace-nowrap">{k}</TableHead>
              <TableCell className="h-auto py-2 whitespace-normal">{text(v[k])}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  return null;
}

function blockMarkdown(block: Block, value: unknown): string {
  const head = `## ${block.heading}\n\n`;
  if (typeof value === "string") return `${head}${value}\n`;
  if (Array.isArray(value) && !isRows(value)) return `${head}${value.map((i) => `- ${text(i)}`).join("\n")}\n`;
  if (isRows(value)) {
    const cols = block.columns?.length ? block.columns : Object.keys(value[0]);
    const cell = (v: unknown) => text(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
    return `${head}| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |\n${value.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`).join("\n")}\n`;
  }
  if (typeof value === "object" && value) {
    const v = value as Row;
    const keys = (block.fields?.length ? block.fields : Object.keys(v)).filter((k) => !isEmpty(v[k]));
    return `${head}${keys.map((k) => `- **${k}:** ${text(v[k])}`).join("\n")}\n`;
  }
  return "";
}

function visibleBlocks(doc: Generated) {
  return Object.entries(doc.blocks || {})
    .map(([id, block]) => ({ id, block, value: doc.content?.[id] }))
    .filter((b) => !isEmpty(b.value));
}

function CopyButton({ getText, label }: { getText: () => string; label: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(getText());
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Could not copy to the clipboard.");
        }
      }}
    >
      {done ? <CheckIcon className="stroke-[1.5] text-success" /> : <CopyIcon className="stroke-[1.5]" />}
    </Button>
  );
}

export function GenerateTab({ active }: { active: boolean }) {
  const [types, setTypes] = React.useState<{ id: string; name: string }[]>([]);
  const [typesError, setTypesError] = React.useState<string | null>(null);
  const [docType, setDocType] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [completed, setCompleted] = React.useState<string[]>([]);
  const [result, setResult] = React.useState<Generated | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [history, setHistory] = React.useState<HistoryRow[] | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState("");
  const abort = React.useRef<AbortController | null>(null);
  const resultRef = React.useRef<HTMLDivElement>(null);
  const restored = React.useRef(false);
  const elapsed = useElapsed(busy);

  // Restore an unsent description (browser storage may be unavailable).
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) setDescription(saved);
    } catch {
      /* ignore */
    }
    restored.current = true;
  }, []);
  React.useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem(DRAFT_KEY, description);
    } catch {
      /* ignore */
    }
  }, [description]);

  React.useEffect(() => {
    api<{ types?: { id: string; name: string }[] }>("/api/generate/types")
      .then((d) => {
        const t = d.types || [];
        setTypes(t);
        if (t.length) setDocType(t[0].id);
      })
      .catch((err) => setTypesError((err as Error).message));
  }, []);

  const loadHistory = React.useCallback(async () => {
    try {
      const data = await api<{ generated?: HistoryRow[] }>("/api/generate");
      setHistory(data.generated || []);
      setHistoryError(null);
    } catch (err) {
      setHistoryError((err as Error).message);
    }
  }, []);

  React.useEffect(() => {
    if (active) loadHistory();
  }, [active, loadHistory]);

  function show(doc: Generated) {
    setResult(doc);
    setError(null);
    setOpen(Object.fromEntries(visibleBlocks(doc).map((b) => [b.id, true])));
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const len = description.trim().length;
  const tooShort = len < MIN;
  const tooLong = len > MAX;

  async function run() {
    if (!docType || busy) return;
    if (tooShort) {
      toast.error("Add a bit more detail — at least a couple of sentences about the project.");
      return;
    }
    if (tooLong) {
      toast.error(`The description is too long (max ${MAX} characters).`);
      return;
    }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setResult(null);
    setError(null);
    setCompleted([]);
    setProgress(null);
    try {
      const doc = await streamJob<Generated>(
        "/api/generate?stream=1",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc_type: docType, description: description.trim() }) },
        {
          signal: ctrl.signal,
          onProgress: (p) => {
            setProgress(p);
            setCompleted((c) => [...c, p.message]);
          },
        }
      );
      show(doc);
      loadHistory();
    } catch (err) {
      if (isAbort(err)) toast.message("Cancelled. A draft already in progress may still appear under Recent drafts.");
      else setError((err as Error).message);
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  async function openDraft(id: string) {
    try {
      show(await api<Generated>(`/api/generate/${encodeURIComponent(id)}`));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const blocks = result ? visibleBlocks(result) : [];
  const allOpen = blocks.length > 0 && blocks.every((b) => open[b.id]);
  const fullMarkdown = () => (result ? `# ${result.doc_name}\n\n${blocks.map((b) => blockMarkdown(b.block, b.value)).join("\n")}` : "");
  const shownHistory = (history ?? []).filter((g) => `${g.doc_name} ${g.description ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const currentLabel = progress ? `${progress.message} (${progress.done} of ${progress.total})` : "Reading the framework and drafting sections…";

  return (
    <div className="flex flex-col gap-3">
      <PageHeader title="Draft a document from a description" />

      <Card className="gap-3 p-4">
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="gen-type">Document type</Label>
          <NativeSelect id="gen-type" value={docType} disabled={busy} onChange={(e) => setDocType(e.target.value)}>
            {types.length === 0 && <option value="">{typesError ?? "No document types available"}</option>}
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="gen-description">Describe the project</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <SparklesIcon className="size-3.5 stroke-[1.5]" /> Try an example:
              </span>
              {EXAMPLES.map((ex) => (
                <Button key={ex.label} variant="outline" size="xs" disabled={busy} onClick={() => setDescription(ex.text)}>
                  {ex.label}
                </Button>
              ))}
            </div>
          </div>
          <Textarea
            id="gen-description"
            rows={7}
            value={description}
            disabled={busy}
            aria-invalid={tooLong}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
            }}
            placeholder="Location, grades, number of children, timeline, baseline and target, budget, partner, risks…  (Ctrl/⌘ + Enter to generate)"
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className={cn(len > 0 && tooShort && "text-warning")}>
              {len === 0
                ? "Include location, reach, timeline, baseline/target and budget for a fuller draft."
                : tooShort
                  ? `Add a little more detail (${MIN - len} more characters).`
                  : "Looks good."}
            </span>
            <span className={cn("tabular", tooLong && "text-destructive")}>
              {len.toLocaleString()} / {MAX.toLocaleString()}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={run} disabled={busy || tooShort || tooLong || !docType}>
            <FilePenLineIcon className="stroke-[1.5]" /> Generate draft
          </Button>
          {description && !busy && (
            <Button variant="ghost" onClick={() => setDescription("")}>
              Clear
            </Button>
          )}
          <span className="text-xs text-muted-foreground">Sections are drafted in parallel, so this usually takes a minute or less.</span>
        </div>

        {busy && <JobProgress current={currentLabel} completed={completed} progress={progress} elapsed={elapsed} onCancel={() => abort.current?.abort()} />}
      </Card>

      <div ref={resultRef} className="flex flex-col gap-3">
        {error && (
          <Card className="gap-0 p-3">
            <Notice tone="destructive">
              <b>Generation failed.</b>
              <br />
              {error}
            </Notice>
          </Card>
        )}

        {result && (
          <>
            <Card className="gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="m-0 text-base font-semibold">{result.doc_name}</h2>
                <div className="flex flex-wrap gap-2">
                  <Button asChild>
                    <a href={`/api/generate/${encodeURIComponent(result.id)}/docx`}>
                      <DownloadIcon className="stroke-[1.5]" /> Word (.docx)
                    </a>
                  </Button>
                  <Button variant="outline" asChild>
                    <a href={`/api/generate/${encodeURIComponent(result.id)}/markdown`}>Markdown</a>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(fullMarkdown());
                        toast.success("Draft copied as Markdown.");
                      } catch {
                        toast.error("Could not copy to the clipboard.");
                      }
                    }}
                  >
                    <CopyIcon className="stroke-[1.5]" /> Copy all
                  </Button>
                </div>
              </div>
              <p className="mb-0 text-xs text-muted-foreground">
                Drafted {result.created_at} · {result.stats?.api_calls ?? 0} model call(s) · {result.stats?.elapsed_s ?? "?"}s
              </p>
              {(result.warnings || []).map((w) => (
                <Notice key={w}>{w}</Notice>
              ))}
              <Notice tone="info">
                This is a first draft, grounded in the framework where it could be — review it, fill in anything marked &quot;To be determined&quot; or
                &quot;Pending&quot;, and have it checked by the Programme Committee before relying on it. If you download the Word file, right-click the
                Table of Contents and choose &quot;Update Field&quot; to refresh the page numbers.
              </Notice>
            </Card>

            <div className="grid items-start gap-3 lg:grid-cols-[200px_1fr]">
              <nav aria-label="Draft sections" className="sticky top-0 hidden rounded-xl border bg-card p-2 text-[13px] lg:block">
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Sections</div>
                <ul className="m-0 grid list-none gap-0.5 p-0">
                  {blocks.map((b) => (
                    <li key={b.id}>
                      <button
                        type="button"
                        className="w-full truncate rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        onClick={() => {
                          setOpen((o) => ({ ...o, [b.id]: true }));
                          requestAnimationFrame(() => document.getElementById(`draft-${b.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
                        }}
                      >
                        {b.block.heading}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>

              <Card className="gap-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="m-0 text-base font-semibold">Draft content</h2>
                  <Button variant="outline" size="xs" onClick={() => setOpen(Object.fromEntries(blocks.map((b) => [b.id, !allOpen])))}>
                    {allOpen ? "Collapse all" : "Expand all"}
                  </Button>
                </div>
                {blocks.map((b) => (
                  <div key={`${result.id}-${b.id}`} id={`draft-${b.id}`} className="scroll-mt-2">
                    <Section
                      title={b.block.heading}
                      open={!!open[b.id]}
                      onToggle={(o) => setOpen((prev) => ({ ...prev, [b.id]: o }))}
                      aside={<CopyButton label={`Copy ${b.block.heading}`} getText={() => blockMarkdown(b.block, b.value)} />}
                    >
                      <BlockBody block={b.block} value={b.value} />
                    </Section>
                  </div>
                ))}
              </Card>
            </div>
          </>
        )}
      </div>

      <Card className="gap-0 p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
          <h2 className="m-0 text-sm font-semibold">Recent drafts</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 stroke-[1.5] text-muted-foreground" />
              <Input aria-label="Filter drafts" className="h-7 w-44 pl-7 text-xs" placeholder="Filter drafts…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Button variant="outline" size="xs" onClick={loadHistory}>
              <RefreshCwIcon className="stroke-[1.5]" /> Refresh
            </Button>
          </div>
        </div>
        {historyError ? (
          <div className="p-3">
            <Notice tone="destructive">{historyError}</Notice>
          </div>
        ) : history && history.length === 0 ? (
          <EmptyState icon={FilePenLineIcon} title="No drafts generated yet." />
        ) : shownHistory.length === 0 && history ? (
          <EmptyState icon={SearchIcon} title="No drafts match your filter." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownHistory.map((g) => (
                <TableRow key={g.id} className={cn("cursor-pointer", result?.id === g.id && "bg-accent/60")} onClick={() => openDraft(g.id)}>
                  <TableCell>{g.doc_name}</TableCell>
                  <TableCell className="max-w-md truncate">
                    {g.description}
                    {(g.description?.length ?? 0) >= 140 ? "…" : ""}
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">{g.created_at}</TableCell>
                  <TableCell className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="xs" onClick={() => openDraft(g.id)}>
                      Open
                    </Button>
                    <Button variant="ghost" size="xs" asChild>
                      <a href={`/api/generate/${encodeURIComponent(g.id)}/docx`}>Word</a>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
