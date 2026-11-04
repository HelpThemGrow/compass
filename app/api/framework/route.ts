import { NextResponse } from "next/server";
import * as ingest from "@/lib/ingest";

export async function GET() {
  // Files added or removed outside the app (e.g. copied into frameworks/) are
  // picked up on the next look - unless the last sync failed, in which case
  // retrying on every poll would just loop; the user retries explicitly.
  const report = ingest.statusReport();
  if (report.stale && report.state !== "error") ingest.scheduleSync();
  return NextResponse.json({ status: ingest.statusReport(), documents: ingest.listDocuments() });
}
