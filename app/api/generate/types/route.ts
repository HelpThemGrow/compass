import { NextResponse } from "next/server";
import * as generation from "@/lib/server/generation";

export async function GET() {
  return NextResponse.json({ types: generation.availableTypes() });
}
