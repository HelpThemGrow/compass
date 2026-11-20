"use client";

import * as React from "react";
import { DatabaseIcon, HardDriveIcon, LibraryIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { api, toLogin } from "@/lib/client/api";
import { useApp } from "@/components/providers/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { StatusBadge } from "@/components/common/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Doc {
  path: string;
  size_kb: number;
  modified: string;
  index_state: string;
  chunks?: number;
  error?: string;
}
interface FrameworkStatus {
  state?: string;
  built_at?: string;
  documents?: number;
  chunks?: number;
  files_on_disk?: number;
  frameworks_dir?: string;
  message?: string;
  errors?: string[];
  progress?: { done: number; total: number; current?: string };
}
interface UploadResult {
  saved?: string[];
  errors?: string[];
  warnings?: string[];
}

const STATE_LABEL: Record<string, string> = { ready: "Ready", building: "Updating", empty: "Empty", not_built: "Not built", error: "Error" };

// Indexing runs in the background on the server: every action returns quickly, and load() polls until the
// index has caught up.
export function LibraryTab({ active }: { active: boolean }) {
  const { isEditor } = useApp();
  const [status, setStatus] = React.useState<FrameworkStatus>({});
  const [docs, setDocs] = React.useState<Doc[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [upload, setUpload] = React.useState<{ busy?: string; result?: UploadResult; error?: string }>({});
  const [removing, setRemoving] = React.useState<Set<string>>(new Set());
  const removingRef = React.useRef(removing);
  removingRef.current = removing;

  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const polling = React.useRef(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    try {
      const data = await api<{ status?: FrameworkStatus; documents?: Doc[] }>("/api/framework");
      const st = data.status || {};
      const list = data.documents || [];
      const building = st.state === "building";
      const pending = list.filter((d) => d.index_state === "pending").length;
      setStatus(st);
      setDocs(list);
      setLoaded(true);
      setLoadError(null);

      if (timer.current) clearTimeout(timer.current);
      // Stop on a failed sync: the error is shown and the user retries explicitly.
      polling.current = (building || pending > 0) && st.state !== "error";
      if (polling.current) {
        timer.current = setTimeout(load, 1500);
      } else {
        // Indexing finished: drop the "added" notice but keep any upload errors.
        setUpload((u) => (u.result ? { ...u, result: { ...u.result, saved: undefined } } : u));
      }
    } catch (err) {
      setLoadError(`Could not refresh the knowledge base: ${(err as Error).message}`);
      // One failed refresh must not stop tracking an update that is still running.
      if (polling.current) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(load, 5000);
      }
    }
  }, []);

  React.useEffect(() => {
    if (active) load();
  }, [active, load]);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const building = status.state === "building";
  const pendingCount = docs.filter((d) => d.index_state === "pending").length;
  const p = status.progress;
  const stateLabel = STATE_LABEL[status.state ?? ""] || status.state || "Unknown";

  async function rebuild() {
    if (
      !confirm(
        "Re-embed every document from scratch?\n\nThis is only needed if search results look wrong. Added and removed documents are indexed automatically."
      )
    )
      return;
    setUpload({});
    try {
      await api("/api/framework/rebuild", { method: "POST" });
      await load();
    } catch (err) {
      setUpload({ error: (err as Error).message });
    }
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    const body = new FormData();
    Array.from(files).forEach((f) => body.append("files", f));
    setUpload({ busy: `Uploading ${files.length} file${files.length === 1 ? "" : "s"}…` });
    try {
      const res = await api<UploadResult>("/api/framework/upload", { method: "POST", body });
      setUpload({ result: res });
      await load();
    } catch (err) {
      setUpload({ error: (err as Error).message });
    }
    e.target.value = "";
  }

  async function remove(target: string) {
    if (!confirm(`Remove "${target}" from the knowledge base?\n\nThis deletes the file from disk.`)) return;
    setRemoving((s) => new Set(s).add(target));
    try {
      const res = await fetch(`/api/framework/document?path=${encodeURIComponent(target)}`, { method: "DELETE" });
      if (res.status === 401) {
        toLogin();
        return;
      }
      // 404 means another tab (or a double click) already removed it - nothing to report.
      if (!res.ok && res.status !== 404) {
        let payload: { detail?: string } | null = null;
        try {
          payload = await res.json();
        } catch {
          /* non-JSON error body */
        }
        throw new Error(payload?.detail || `${res.status} ${res.statusText}`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRemoving((s) => {
        const n = new Set(s);
        n.delete(target);
        return n;
      });
      await load();
    }
  }

  const progressText = p && p.total ? ` — checking ${p.done} of ${p.total} files${p.current ? ` (${p.current})` : ""}` : "";
  const r = upload.result;

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Knowledge base"
        actions={
          isEditor && (
            <>
              <Button variant="outline" size="sm" disabled={building} onClick={rebuild}>
                <RefreshCwIcon className="stroke-[1.5]" /> Rebuild index
              </Button>
              <Button size="sm" onClick={() => fileInput.current?.click()}>
                <PlusIcon className="stroke-[1.5]" /> Add documents
              </Button>
            </>
          )
        }
      />

      <input ref={fileInput} type="file" className="hidden" multiple accept=".pdf,.docx,.txt,.md,.markdown,.xlsx,.csv" onChange={onFiles} />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <StatCard
          icon={DatabaseIcon}
          label="Index"
          value={stateLabel}
          detail={status.built_at ? `updated ${status.built_at}` : "not built yet"}
          badge={<StatusBadge tone={status.state === "ready" ? "success" : status.state === "error" ? "destructive" : "warning"} label={stateLabel} />}
        />
        <StatCard icon={LibraryIcon} label="Documents" value={status.documents ?? 0} detail={`${status.chunks ?? 0} searchable passages`} />
        <StatCard icon={HardDriveIcon} label="Files on disk" value={status.files_on_disk ?? 0} detail={status.frameworks_dir} />
      </div>

      {(building || pendingCount > 0) && (
        <Notice className="flex items-center gap-2">
          <Spinner />
          <span>
            Updating the index{progressText}. Only new or changed files are embedded; removed files are dropped instantly. Searches keep working on the
            current index meanwhile.
          </span>
        </Notice>
      )}
      {status.state === "error" && (
        <Notice tone="destructive">
          <b>Indexing failed:</b> {status.message || "unknown error"}
        </Notice>
      )}
      {(status.errors ?? []).length > 0 && (
        <Notice tone="destructive">
          <b>Could not index:</b>
          {status.errors!.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Notice>
      )}
      {loadError && <Notice tone="destructive">{loadError}</Notice>}

      {upload.busy && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> {upload.busy}
        </div>
      )}
      {upload.error && <Notice tone="destructive">{upload.error}</Notice>}
      {r?.saved && r.saved.length > 0 && (
        <Notice tone="info">
          Added {r.saved.join(", ")}. Indexing only {r.saved.length === 1 ? "the new file — it becomes" : "the new files — they become"} searchable when
          marked <b>Indexed</b> below.
        </Notice>
      )}
      {r?.errors && r.errors.length > 0 && (
        <Notice tone="destructive">
          {r.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Notice>
      )}
      {r?.warnings && r.warnings.length > 0 && (
        <Notice>
          {r.warnings.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Notice>
      )}

      <Card className="gap-0 p-0">
        {loaded && docs.length === 0 ? (
          <EmptyState icon={LibraryIcon} title="No framework documents yet.">
            Add your policies, standards and templates.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Modified</TableHead>
                <TableHead>Search index</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.path}>
                  <TableCell>{d.path}</TableCell>
                  <TableCell className="tabular">{d.size_kb} KB</TableCell>
                  <TableCell className="tabular text-muted-foreground">{d.modified}</TableCell>
                  <TableCell>
                    {d.index_state === "indexed" ? (
                      <Badge variant="success">Indexed · {d.chunks} passages</Badge>
                    ) : d.index_state === "error" ? (
                      <Badge variant="destructive" title={d.error}>
                        Could not index
                      </Badge>
                    ) : (
                      <Badge variant="warning">Indexing…</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {isEditor && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${d.path}`}
                            disabled={removingRef.current.has(d.path)}
                            onClick={() => remove(d.path)}
                            className="text-destructive hover:text-destructive"
                          >
                            {removing.has(d.path) ? <Spinner /> : <Trash2Icon className="stroke-[1.5]" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{removing.has(d.path) ? "Removing…" : "Remove"}</TooltipContent>
                      </Tooltip>
                    )}
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

