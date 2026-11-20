import { NextResponse } from "next/server";
<<<<<<< HEAD
import * as rubric from "@/lib/server/rubric";
import { summary } from "@/lib/server/rubric";
=======
import * as rubric from "@/lib/rubric";
import { summary } from "@/lib/rubric";
>>>>>>> 32f2f75

export async function GET() {
  return NextResponse.json({ rubrics: Object.values(rubric.loadAll(true)).map(summary) });
}
