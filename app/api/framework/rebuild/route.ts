import { NextResponse } from "next/server";
import * as ingest from "@/lib/server/ingest";
import { AuthError, audit, requireUser } from "@/lib/server/auth";

/** Re-embeds every document from scratch, in the background. */
export async function POST(req: Request) {
  try {
    const user = requireUser(req, "editor");
    ingest.scheduleSync({ force: true });
    audit(user.email, "kb_rebuild");
    return NextResponse.json({ status: ingest.statusReport() });
  } catch (exc) {
    if (exc instanceof AuthError) return NextResponse.json({ detail: exc.message }, { status: exc.status });
    throw exc;
  }
}
