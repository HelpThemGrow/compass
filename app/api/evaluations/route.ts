import { NextResponse } from "next/server";
<<<<<<< HEAD
import * as evaluator from "@/lib/server/evaluate";
=======
import * as evaluator from "@/lib/evaluate";
>>>>>>> 32f2f75

export async function GET() {
  return NextResponse.json({ evaluations: evaluator.listEvaluations() });
}
