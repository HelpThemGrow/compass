import { NextResponse } from "next/server";
import * as qa from "@/lib/qa";
import * as llm from "@/lib/llm";

export const maxDuration = 120;

export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({}));
  const question = String(payload.question ?? "").trim();
  if (!question) return NextResponse.json({ detail: "A question is required." }, { status: 400 });
  if (question.length > 2000) return NextResponse.json({ detail: "Question is too long." }, { status: 400 });
  const history = Array.isArray(payload.history) ? payload.history : [];

  const started = Date.now();
  const result = await qa.answer(question, { history: history.slice(-12) });
  return NextResponse.json({
    ...result,
    elapsed_s: Math.round(((Date.now() - started) / 1000) * 10) / 10,
    credits_remaining: llm.ledger.remaining(),
  });
}
