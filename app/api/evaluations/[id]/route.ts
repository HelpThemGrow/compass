import { NextResponse } from "next/server";
import * as evaluator from "@/lib/evaluate";

const VALID = /^[0-9a-f]{1,32}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!VALID.test(id)) return NextResponse.json({ detail: "Report not found." }, { status: 404 });
  const data = evaluator.loadEvaluation(id);
  if (!data) return NextResponse.json({ detail: "Report not found." }, { status: 404 });
  return NextResponse.json(data);
}
