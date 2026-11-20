"use client";

import * as React from "react";
import { CheckIcon, CopyIcon, MessageCircleQuestionIcon, RefreshCwIcon, SendIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { isAbort, toLogin, stripMd } from "@/lib/client/api";
import { renderMarkdown } from "@/lib/client/markdown";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";

interface Source {
  n: number;
  kind: string;
  citation: string;
  heading?: string;
  excerpt: string;
}
type Msg =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "bot"; question: string; label?: string; answer: string; sources: Source[]; finished: boolean; stopped?: boolean; error?: string };

const SUGGESTIONS = [
  "What must a partner provide for due diligence?",
  "What are the requirements of New Proposal",
  "What must a theory of change contain?",
];

// Markdown from the model is HTML-escaped inside renderMarkdown before any tag is added.
const answerClasses =
  "leading-relaxed [&_blockquote]:my-2 [&_blockquote]:rounded-r-md [&_blockquote]:border-l-[3px] [&_blockquote]:bg-card [&_blockquote]:px-3 [&_blockquote]:py-1.5 [&_blockquote]:text-muted-foreground [&_.cite-ref]:ml-0.5 [&_.cite-ref]:text-[11px] [&_.cite-ref]:font-semibold [&_.cite-ref]:text-primary [&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold [&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:text-sm [&_h5]:font-semibold [&_h6]:mt-3 [&_h6]:mb-1 [&_h6]:text-sm [&_h6]:font-semibold [&_hr]:my-3 [&_li]:my-0.5 [&_ol]:mt-1 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_ul]:mt-1 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&>*:last-child]:mb-0 [&_table]:my-1 [&_table]:w-full [&_table]:text-[13px] [&_th]:border-b [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium [&_td]:border-b [&_td]:px-2 [&_td]:py-1";

export function AskTab() {
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [question, setQuestion] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [meta, setMeta] = React.useState("");
  const history = React.useRef<{ role: string; content: string }[]>([]);
  const chat = React.useRef<HTMLDivElement>(null);
  const nextId = React.useRef(1);
  const abort = React.useRef<AbortController | null>(null);
  const box = React.useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = React.useState<number | null>(null);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setQuestion("");
    if (box.current) box.current.style.height = "";
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;

    const el = chat.current;
    const id = nextId.current++;
    const patch = (p: Partial<Extract<Msg, { role: "bot" }>>) =>
      setMessages((ms) => ms.map((m) => (m.id === id && m.role === "bot" ? { ...m, ...p } : m)));
    setMessages((ms) => [
      ...ms,
      { id: nextId.current++, role: "user", text: q },
      { id, role: "bot", question: q, label: "Finding the relevant policies…", answer: "", sources: [], finished: false },
    ]);
    requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight));

    // Follow the answer as it grows, unless the reader has scrolled up to read.
    const nearBottom = () => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    let answer = "";
    let sources: Source[] = [];
    let finished: { credits_remaining?: number } | null = null;
    let queued = false;
    const render = () => {
      queued = false;
      const follow = nearBottom();
      patch({ label: undefined, answer, sources, finished: !!finished });
      if (follow) requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight));
    };

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history: history.current.slice(-8) }),
        signal: ctrl.signal,
      });
      if (res.status === 401) {
        toLogin();
        return;
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
      const handle = (event: { type: string; sources?: Source[]; text?: string; message?: string; credits_remaining?: number }) => {
        if (event.type === "sources") {
          sources = event.sources || [];
          if (!answer) {
            patch({ label: `Reading ${sources.length} relevant document${sources.length === 1 ? "" : "s"} and writing the answer…` });
          }
        } else if (event.type === "delta") {
          answer += event.text;
          if (!queued) {
            queued = true;
            requestAnimationFrame(render);
          }
        } else if (event.type === "done") {
          finished = event;
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (line) handle(JSON.parse(line));
        }
      }
      if (buffered.trim()) handle(JSON.parse(buffered));

      finished = finished || {};
      render();
      history.current.push({ role: "user", content: q }, { role: "assistant", content: answer });
      const f = finished as { credits_remaining?: number };
      if (f.credits_remaining !== undefined) setMeta(`${f.credits_remaining} model calls remaining in budget`);
    } catch (err) {
      if (isAbort(err)) {
        // Keep whatever was written before the user pressed Stop.
        patch({ label: undefined, answer, sources, finished: true, stopped: true });
      } else {
        patch({ label: undefined, answer, sources: [], finished: true, error: (err as Error).message });
      }
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  const lastBotId = [...messages].reverse().find((m) => m.role === "bot")?.id;

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Ask a question about the framework"
        actions={
          <>
            <span className="text-xs text-muted-foreground">{meta}</span>
            {messages.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setMessages([]);
                  history.current = [];
                }}
              >
                <Trash2Icon className="stroke-[1.5]" /> Clear chat
              </Button>
            )}
          </>
        }
      />

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <Button key={s} variant="outline" size="sm" disabled={busy} onClick={() => ask(s)}>
              {s}
            </Button>
          ))}
        </div>

        <div ref={chat} className="flex max-h-[56vh] min-h-24 flex-col gap-3 overflow-y-auto pr-1">
          {messages.length === 0 && (
            <EmptyState icon={MessageCircleQuestionIcon} title="Ask anything covered by the documents in the knowledge base.">
              Answers are drawn only from those documents and cite where each claim comes from.
            </EmptyState>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="max-w-[92%] self-end rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
                {m.text}
              </div>
            ) : (
              <div key={m.id} className="max-w-[92%] self-start rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
                {m.label ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Spinner /> {m.label}
                  </div>
                ) : (
                  <>
                    {m.answer && (
                      <div className={cn(answerClasses, "[&_code]:rounded-md [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs")}>
                        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(m.answer) }} />
                        {!m.finished && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary align-text-bottom opacity-60" />}
                      </div>
                    )}
                    {m.error && <Notice tone="destructive">{m.error}</Notice>}
                    {m.stopped && <div className="mt-2 text-xs text-muted-foreground">Stopped.</div>}
                    {m.finished && (m.answer || m.error) && (
                      <div className="mt-2 flex items-center gap-1">
                        {m.answer && (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(m.answer);
                                setCopied(m.id);
                                setTimeout(() => setCopied((c) => (c === m.id ? null : c)), 1500);
                              } catch {
                                toast.error("Could not copy to the clipboard.");
                              }
                            }}
                          >
                            {copied === m.id ? <CheckIcon className="stroke-[1.5] text-success" /> : <CopyIcon className="stroke-[1.5]" />}
                            {copied === m.id ? "Copied" : "Copy"}
                          </Button>
                        )}
                        {m.id === lastBotId && (
                          <Button variant="ghost" size="xs" disabled={busy} onClick={() => ask(m.question)}>
                            <RefreshCwIcon className="stroke-[1.5]" /> Ask again
                          </Button>
                        )}
                      </div>
                    )}
                    {m.finished && m.sources.length > 0 && (
                      <details className="mt-3 border-t pt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          {m.sources.length} source{m.sources.length === 1 ? "" : "s"} used
                        </summary>
                        {m.sources.map((s) => (
                          <div key={s.n} className="border-b py-2 text-xs last:border-b-0">
                            <div className="flex flex-wrap items-center gap-1.5 font-medium">
                              [{s.n}] {stripMd(s.citation)}
                              <Badge variant="muted">{s.kind === "document" ? "full document" : "extract"}</Badge>
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              {s.kind === "document" && s.heading ? (
                                <>
                                  <b>Most relevant section:</b> {stripMd(s.heading)} —{" "}
                                </>
                              ) : null}
                              {stripMd(s.excerpt)}
                              {s.excerpt.length >= 500 ? "…" : ""}
                            </div>
                          </div>
                        ))}
                      </details>
                    )}
                  </>
                )}
              </div>
            )
          )}
        </div>

        <div className="flex items-end gap-2">
          <Textarea
            ref={box}
            rows={2}
            className="min-h-12 flex-1 resize-y"
            aria-label="Your question"
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ask(question);
            }}
            placeholder="e.g. What is the ceiling on administrative costs, and when can it be exceeded?"
          />
          {busy ? (
            <Button variant="outline" onClick={() => abort.current?.abort()}>
              <SquareIcon className="stroke-[1.5]" /> Stop
            </Button>
          ) : (
            <Button onClick={() => ask(question)} disabled={!question.trim()}>
              <SendIcon className="stroke-[1.5]" /> Ask
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
