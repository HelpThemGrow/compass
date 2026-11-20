/**
 * Newline-delimited JSON responses for long-running routes (verify, generate).
 * The body is a sequence of events: {type:"progress",...}, then one {type:"result",result} or
 * {type:"error",message}. Same wire format the Ask route already uses.
 */
export interface Progress {
  message: string;
  done: number;
  total: number;
}

export function ndjsonResponse(
  run: (progress: (p: Progress) => void) => Promise<unknown>,
  errorMessage: (exc: unknown) => string
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true; // client went away
        }
      };
      run((p) => emit({ type: "progress", ...p }))
        .then((result) => emit({ type: "result", result }))
        .catch((exc) => emit({ type: "error", message: errorMessage(exc) }))
        .finally(() => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        });
    },
    cancel() {
      closed = true;
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
