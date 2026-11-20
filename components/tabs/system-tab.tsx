"use client";

import * as React from "react";
import { BoxesIcon, ClipboardCheckIcon, CpuIcon, DatabaseIcon, FileTextIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";

import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { StatusBadge } from "@/components/common/status-badge";

interface Health {
  llm?: { configured?: boolean; model?: string; qa_model?: string; ledger?: { calls?: number; budget?: number; remaining?: number } };
  embeddings?: { backend?: string; dim?: number; detail?: string };
  framework?: { state?: string; documents?: number; chunks?: number };
  rubrics?: { criteria_count: number }[];
  supported_types?: string[];
  rubric_error?: string;
}

export function SystemTab({ active }: { active: boolean }) {
  const [h, setH] = React.useState<Health | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setH(await api<Health>("/api/health"));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);
  React.useEffect(() => {
    if (active) load();
  }, [active, load]);

  const llm = h?.llm ?? {};
  const led = llm.ledger ?? {};
  const emb = h?.embeddings ?? {};
  const fw = h?.framework ?? {};
  const usedPct = led.budget ? Math.round(((led.calls ?? 0) / led.budget) * 100) : 0;
  const rubrics = h?.rubrics ?? [];
  const types = h?.supported_types ?? [];

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="System status"
        actions={
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCwIcon className="stroke-[1.5]" /> Refresh
          </Button>
        }
      />

      {error && <Notice tone="destructive">{error}</Notice>}

      {h && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          <StatCard
            icon={CpuIcon}
            label="Model access"
            value={llm.configured ? "Connected" : "No API key"}
            detail={
              <>
                Verify &amp; generate: {llm.model}
                <br />
                Ask: {llm.qa_model || llm.model}
              </>
            }
            badge={<StatusBadge tone={llm.configured ? "success" : "destructive"} label={llm.configured ? "Connected" : "No API key"} />}
          />
          <StatCard
            icon={GaugeIcon}
            label="Call budget"
            value={`${led.remaining ?? 0} left`}
            detail={`${led.calls ?? 0} of ${led.budget ?? 0} used (${usedPct}%)`}
          />
          <StatCard
            icon={BoxesIcon}
            label="Embeddings"
            value={`${emb.backend || "?"} · ${emb.dim || 0}d`}
            detail={emb.detail}
            badge={<StatusBadge tone={emb.backend === "hash" ? "warning" : "success"} label={emb.backend === "hash" ? "Fallback" : "Local"} />}
          />
          <StatCard
            icon={DatabaseIcon}
            label="Framework index"
            value={fw.state || "?"}
            detail={`${fw.documents ?? 0} documents · ${fw.chunks ?? 0} passages`}
            badge={<StatusBadge tone={fw.state === "ready" ? "success" : "warning"} label={fw.state === "ready" ? "Ready" : fw.state || "Unknown"} />}
          />
          <StatCard
            icon={ClipboardCheckIcon}
            label="Rubrics"
            value={rubrics.length}
            detail={`${rubrics.reduce((a, r) => a + r.criteria_count, 0)} criteria total`}
          />
          <StatCard icon={FileTextIcon} label="Accepted files" value={`${types.length} types`} detail={types.join(" ")} />
        </div>
      )}

      {h && !llm.configured && (
        <Notice>
          No <code>NVIDIA_API_KEY</code> is set. Structural checks and search work without it; criterion scoring and Q&amp;A need a key. Copy{" "}
          <code>.env.example</code> to <code>.env</code> and add a free key from build.nvidia.com, then restart the server.
        </Notice>
      )}
      {h?.rubric_error && (
        <Notice tone="destructive">
          <b>Rubric problem:</b> {h.rubric_error}
        </Notice>
      )}

      <Card className="gap-3 p-4">
        <CardHeader className="px-0">
          <CardTitle className="text-base">How this works</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <p className="mb-0 text-muted-foreground">Three layers run over every submission, in order.</p>
          <ol className="m-0 list-decimal space-y-1.5 pl-5">
            <li>
              <b>Structural checks</b> — required sections, budget arithmetic, unfilled placeholders, registration and safeguarding declarations. Pure
              parsing: instant, free and identical every time.
            </li>
            <li>
              <b>Rubric evaluation</b> — for each criterion the system searches the <em>submitted document</em> for evidence, then judges that evidence
              against the framework standard. Every score is tied to a quoted passage, so a finding can be checked or contested.
            </li>
            <li>
              <b>Framework Q&amp;A</b> — retrieval-grounded answering over the knowledge base, used by the Ask tab.
            </li>
          </ol>
          <p className="mb-0 text-muted-foreground">
            Embeddings and reranking run locally on the CPU, so indexing costs nothing. The hosted model is used only for judging and writing feedback,
            which keeps a full review to roughly ten API calls.
          </p>
          <Notice tone="info">
            This is a pre-check against the written framework. It does not replace review by the programme committee or the board.
          </Notice>
        </CardContent>
      </Card>
    </div>
  );
}
