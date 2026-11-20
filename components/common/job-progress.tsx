import { CheckIcon, XIcon } from "lucide-react";

import type { Progress } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// Live status for a long-running job: current step, a determinate bar when the server reports totals,
// finished steps, elapsed time and a cancel button.
export function JobProgress({
  current,
  completed,
  progress,
  elapsed,
  onCancel,
}: {
  current: string;
  completed: string[];
  progress: Progress | null;
  elapsed: number;
  onCancel: () => void;
}) {
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div role="status" aria-live="polite" className="rounded-md border bg-muted/40 p-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Spinner />
        <span className="font-medium">{current}</span>
        <span className="tabular ml-auto text-xs text-muted-foreground">{elapsed}s</span>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <XIcon className="stroke-[1.5]" /> Cancel
        </Button>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        {pct === null ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        ) : (
          <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${Math.max(pct, 4)}%` }} />
        )}
      </div>
      {completed.length > 0 && (
        <ul className="m-0 mt-2 grid list-none gap-0.5 p-0 text-xs text-muted-foreground">
          {completed.map((c, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <CheckIcon className="size-3.5 stroke-[1.5] text-success" /> {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
