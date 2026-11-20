import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/lib/client/api";

// One central map of status string -> tone, so a status looks the same everywhere.
const STATUS_TONE: Record<string, Tone> = {
  indexed: "success", ready: "success", connected: "success", local: "success", clear: "success", met: "success",
  pending: "warning", building: "warning", updating: "warning", fallback: "warning", partially_met: "warning",
  error: "destructive", not_met: "destructive", blocker: "destructive",
  empty: "muted", not_built: "muted",
  not_applicable: "info", info: "info",
};

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function StatusBadge({ status, label, tone }: { status?: string; label?: string; tone?: Tone }) {
  const key = (status ?? "").toLowerCase();
  const t = tone ?? STATUS_TONE[key] ?? "muted";
  return <Badge variant={t}>{label ?? titleCase(status ?? "Unknown")}</Badge>;
}
