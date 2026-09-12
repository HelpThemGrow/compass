import { NextResponse } from "next/server";
import * as ingest from "@/lib/ingest";

export async function POST() {
  return NextResponse.json({ status: await ingest.rebuild() });
}
