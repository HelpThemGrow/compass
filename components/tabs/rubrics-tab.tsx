"use client";

import * as React from "react";
import { BlocksIcon, ClipboardCheckIcon, ListChecksIcon, TagIcon } from "lucide-react";

import { api, stripMd } from "@/lib/client/api";
import { useApp } from "@/components/providers/app-context";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";

interface RubricDetail {
  version: string;
  description: string;
  dimension_count: number;
  criteria_count: number;
  section_count: number;
  check_count: number;
  dimensions: { name: string; weight: number; criteria: number }[];
  sections: { title: string; required?: boolean }[];
  criteria: { id: string; critical?: boolean; dimension: string; requirement: string; framework_refs?: string[]; weight: number }[];
}

export function RubricsTab({ active }: { active: boolean }) {
  const { rubrics } = useApp();
  const [id, setId] = React.useState("");
  const [detail, setDetail] = React.useState<RubricDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!id && rubrics.length) setId(rubrics[0].id);
  }, [rubrics, id]);

  React.useEffect(() => {
    if (!id || !active) return;
    let cancelled = false;
    api<RubricDetail>(`/api/rubrics/${encodeURIComponent(id)}`)
      .then((r) => {
        if (!cancelled) {
          setDetail(r);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, active]);

  const totalWeight = detail ? detail.dimensions.reduce((a, x) => a + x.weight, 0) || 1 : 1;

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Rubrics"
        actions={
          <NativeSelect aria-label="Rubric" className="w-56" value={id} onChange={(e) => setId(e.target.value)}>
            {rubrics.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
        }
      />

      {!rubrics.length && <EmptyState icon={ClipboardCheckIcon} title="No rubrics defined." />}
      {error && <Notice tone="destructive">{error}</Notice>}

      {detail && !error && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            <StatCard icon={TagIcon} label="Version" value={detail.version} />
            <StatCard icon={BlocksIcon} label="Dimensions" value={detail.dimension_count} />
            <StatCard icon={ClipboardCheckIcon} label="Criteria" value={detail.criteria_count} />
            <StatCard icon={ListChecksIcon} label="Structural checks" value={detail.section_count + detail.check_count} />
          </div>

          <Card className="gap-3 p-4">
            <p className="mb-0 text-muted-foreground">{detail.description}</p>
            <h3 className="mt-1 text-sm font-semibold">Weighting</h3>
            <div className="grid gap-2">
              {detail.dimensions.map((d) => {
                const pct = (d.weight / totalWeight) * 100;
                return (
                  <div key={d.name} className="grid grid-cols-[minmax(160px,1.6fr)_1fr_48px] items-center gap-3 text-[13px]">
                    <span>
                      {d.name} <span className="text-xs text-muted-foreground">· {d.criteria} criteria</span>
                    </span>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="tabular text-right text-xs text-muted-foreground">{pct.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
            <h3 className="mt-1 text-sm font-semibold">Required sections</h3>
            <p className="mb-0 text-xs text-muted-foreground">
              {detail.sections.filter((s) => s.required).map((s) => s.title).join(" · ") || "none"}
            </p>
          </Card>

          <Card className="gap-0 p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Dimension</TableHead>
                  <TableHead>Requirement</TableHead>
                  <TableHead>Weight</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.criteria.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="h-auto py-2 align-top whitespace-nowrap">
                      <code>{c.id}</code> {c.critical && <Badge variant="destructive">critical</Badge>}
                    </TableCell>
                    <TableCell className="h-auto py-2 align-top">{c.dimension}</TableCell>
                    <TableCell className="h-auto py-2 align-top whitespace-normal">
                      {c.requirement}
                      <div className="text-xs text-muted-foreground">{(c.framework_refs || []).map(stripMd).join("; ")}</div>
                    </TableCell>
                    <TableCell className="tabular h-auto py-2 align-top">{c.weight}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
