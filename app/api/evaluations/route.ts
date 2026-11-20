import { NextResponse } from "next/server";
import * as evaluator from "@/lib/server/evaluate";

export async function GET() {
  return NextResponse.json({ evaluations: evaluator.listEvaluations() });
}
