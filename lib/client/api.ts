// Browser-side helpers shared by the tab components (ported unchanged from the old public/app.js).

export function toLogin() {
  location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, options);
  if (res.status === 401) {
    toLogin();
    throw new Error("Your session has ended. Please sign in again.");
  }
  let payload: { detail?: string } | null = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new Error(payload?.detail || `${res.status} ${res.statusText}`);
  return payload as T;
}

// Citations and evidence locations are built from extracted document headings, which sometimes carry raw
// Markdown emphasis. Strip that before showing the label as plain text. Only double-marker bold and
// backtick code are handled - single `*`/`_` are left alone so filenames with underscores survive.
export function stripMd(value: unknown): string {
  return String(value ?? "")
    .replace(/(^|\n)[ \t]*#{1,6}[ \t]+/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export type Tone = "success" | "info" | "warning" | "destructive" | "muted";

// Mirrors the four bands (85/70/55/0): Board Ready / Minor / Major Revisions / Not Ready.
export function bandTone(score: number): Tone {
  if (score >= 85) return "success";
  if (score >= 70) return "info";
  if (score >= 55) return "warning";
  return "destructive";
}

// A structural-only pass must not be coloured like an endorsement.
export const isStructuralOnly = (r: { band?: string }) => r.band === "Structural check only";

export function severityTone(sev: string): Tone {
  return ({ blocker: "destructive", major: "warning", minor: "info", info: "info" } as Record<string, Tone>)[sev] ?? "info";
}

export interface Criterion {
  id: string;
  requirement: string;
  score: number;
  verdict: string;
  confidence?: string;
  evidence_verified?: boolean;
  evidence_quote?: string;
  evidence_location?: string;
  gap?: string;
  recommended_fix?: string;
  framework_refs?: string[];
}
export interface Dimension {
  name: string;
  weight: number;
  score: number;
  criteria: Criterion[];
}
export interface Finding {
  status: string;
  severity: string;
  title: string;
  detail: string;
  remedy: string;
}
export interface Evaluation {
  id: string;
  filename: string;
  band: string;
  band_note?: string;
  overall_score: number;
  content_score: number;
  structure_score: number;
  rubric_name: string;
  rubric_version: string;
  auto_selected?: boolean;
  created_at: string;
  capped_reason?: string;
  warnings?: string[];
  rubric_suggestions?: { name?: string; close_call?: boolean }[];
  stats?: { api_calls?: number };
  summary?: {
    overall_summary?: string;
    strengths?: string[];
    priority_actions?: { action: string; why_it_matters: string; effort?: string; criterion_ids?: string[] }[];
    reviewer_note?: string;
  };
  deterministic?: { word_count?: number; findings?: Finding[]; missing_sections?: string[] };
  dimensions?: Dimension[];
}
export interface RubricOption {
  id: string;
  name: string;
  version: string;
}

export interface Progress {
  message: string;
  done: number;
  total: number;
}

/**
 * Run a long job whose route streams newline-delimited JSON (?stream=1): progress events, then one result.
 * Rejects with an AbortError if `signal` is aborted.
 */
export async function streamJob<T>(
  path: string,
  init: RequestInit,
  opts: { onProgress?: (p: Progress) => void; signal?: AbortSignal } = {}
): Promise<T> {
  const res = await fetch(path, { ...init, signal: opts.signal });
  if (res.status === 401) {
    toLogin();
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!res.ok || !res.body) {
    let payload: { detail?: string } | null = null;
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new Error(payload?.detail || `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let result: T | undefined;
  let failure: string | null = null;
  const handle = (line: string) => {
    const event = JSON.parse(line);
    if (event.type === "progress") opts.onProgress?.(event);
    else if (event.type === "result") result = event.result as T;
    else if (event.type === "error") failure = event.message;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) handle(line);
    }
  }
  if (buffered.trim()) handle(buffered.trim());
  if (failure) throw new Error(failure);
  if (result === undefined) throw new Error("The server closed the connection before finishing.");
  return result;
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
