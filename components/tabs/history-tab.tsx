"use client";

import * as React from "react";
import { FileClockIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { api, bandTone, type Evaluation } from "@/lib/client/api";
import { useApp } from "@/components/providers/app-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { StatusBadge } from "@/components/common/status-badge";

interface Row {
  id: string;
  filename: string;
  rubric_name: string;
  overall_score: number;
  band: string;
  created_at: string;
}

export function HistoryTab({ active }: { active: boolean }) {
  const { openEvaluation } = useApp();
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const data = await api<{ evaluations?: Row[] }>("/api/evaluations");
      setRows(data.evaluations || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  React.useEffect(() => {
    if (active) load();
  }, [active, load]);

  async function open(id: string) {
    try {
      openEvaluation(await api<Evaluation>(`/api/evaluations/${encodeURIComponent(id)}`));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Past reviews"
        actions={
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCwIcon className="stroke-[1.5]" /> Refresh
          </Button>
        }
      />
      <Card className="gap-0 p-0">
        {error ? (
          <div className="p-3">
            <Notice tone="destructive">{error}</Notice>
          </div>
        ) : rows && rows.length === 0 ? (
          <EmptyState icon={FileClockIcon} title="No reviews yet." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Rubric</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Reviewed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rows ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{e.filename}</TableCell>
                  <TableCell>{e.rubric_name}</TableCell>
                  <TableCell className="tabular font-medium">{e.overall_score}</TableCell>
                  <TableCell>
                    <StatusBadge label={e.band} tone={e.band === "Structural check only" ? "info" : bandTone(e.overall_score)} />
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">{e.created_at}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="xs" onClick={() => open(e.id)}>
                      Open
                    </Button>
                    <Button variant="ghost" size="xs" asChild>
                      <a href={`/api/evaluations/${encodeURIComponent(e.id)}/markdown`}>Memo</a>
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
