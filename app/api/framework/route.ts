import { NextResponse } from "next/server";
import * as ingest from "@/lib/ingest";

export async function GET() {
  return NextResponse.json({ status: ingest.statusReport(), documents: ingest.listDocuments() });
}
