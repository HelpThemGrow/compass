import { NextResponse } from "next/server";
import * as generation from "@/lib/server/generation";
import * as llm from "@/lib/server/llm";
import * as sensitive from "@/lib/server/sensitive";
import { audit, sessionUser } from "@/lib/server/auth";
import { ndjsonResponse } from "@/lib/server/stream";

function failureMessage(exc: unknown): string {
  if (exc instanceof generation.GenerationError || exc instanceof llm.BudgetExhausted || exc instanceof llm.LLMUnavailable || exc instanceof llm.AccessDenied) {
    return exc.message;
  }
  return String((exc as Error)?.message ?? exc);
}

export const maxDuration = 300;

export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({}));
  const docType = String(payload.doc_type ?? "").trim();
  const description = String(payload.description ?? "").trim();
  if (!docType) return NextResponse.json({ detail: "doc_type is required." }, { status: 400 });
  if (description.length > 8000) return NextResponse.json({ detail: "Description is too long (max 8000 characters)." }, { status: 400 });
  const findings = sensitive.blocking(sensitive.scanText(description));
  if (findings.length) {
    audit(sessionUser(req.headers.get("cookie"))?.email ?? null, "sensitive_blocked", { where: "generate", found: findings.map((f) => f.kind) });
    return NextResponse.json({ detail: sensitive.blockedMessage("The description", findings) }, { status: 400 });
  }

  // ?stream=1: progress events while the draft is written, then the result (same body as below).
  if (new URL(req.url).searchParams.get("stream") === "1") {
    return ndjsonResponse((progress) => generation.generate(docType, description, progress), failureMessage);
  }

  try {
    const result = await generation.generate(docType, description);
    return NextResponse.json(result);
  } catch (exc) {
    if (exc instanceof generation.GenerationError) return NextResponse.json({ detail: exc.message }, { status: 400 });
    if (exc instanceof llm.BudgetExhausted) return NextResponse.json({ detail: exc.message }, { status: 429 });
    if (exc instanceof llm.LLMUnavailable || exc instanceof llm.AccessDenied) {
      return NextResponse.json({ detail: exc.message }, { status: 503 });
    }
    throw exc;
  }
}

export async function GET() {
  return NextResponse.json({ generated: generation.listGenerated() });
}
