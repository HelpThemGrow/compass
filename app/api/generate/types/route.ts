import { NextResponse } from "next/server";
import * as generation from "@/lib/generation";

export async function GET() {
  return NextResponse.json({ types: generation.availableTypes() });
}
