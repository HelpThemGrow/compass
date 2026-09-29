import { NextResponse } from "next/server";
import * as qa from "@/lib/qa";
import * as llm from "@/lib/llm";

export const maxDuration = 300;

/**
 * Streams the answer as newline-delimited JSON events:
 *   {"type":"sources", ...}  {"type":"delta","text":...}*  {"type":"done", ...}
 */
export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({}));
  const question = String(payload.question ?? "").trim();
  if (!question) return NextResponse.json({ detail: "A question is required." }, { status: 400 });
  if (question.length > 2000) return NextResponse.json({ detail: "Question is too long." }, { status: 400 });
  const history = Array.isArray(payload.history) ? payload.history.slice(-12) : [];

  const started = Date.now();
  const encoder = new TextEncoder();
  const events = qa.answerStream(question, history);

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        const event =
          value.type === "done"
            ? {
                ...value,
                elapsed_s: Math.round(((Date.now() - started) / 1000) * 10) / 10,
                credits_remaining: llm.ledger.remaining(),
              }
            : value;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      } catch (exc) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: String((exc as Error).message ?? exc) })}\n`));
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
