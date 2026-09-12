import { NextResponse } from "next/server";
import * as rubric from "@/lib/rubric";
import { summary } from "@/lib/rubric";

export async function GET() {
  return NextResponse.json({ rubrics: Object.values(rubric.loadAll(true)).map(summary) });
}
