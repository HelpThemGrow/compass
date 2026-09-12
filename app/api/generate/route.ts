import { NextResponse } from "next/server";
import * as generation from "@/lib/generation";
import * as llm from "@/lib/llm";

export const maxDuration = 300;

export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({}));
  const docType = String(payload.doc_type ?? "").trim();
  const description = String(payload.description ?? "").trim();
  if (!docType) return NextResponse.json({ detail: "doc_type is required." }, { status: 400 });
  if (description.length > 8000) return NextResponse.json({ detail: "Description is too long (max 8000 characters)." }, { status: 400 });

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
