import { NextResponse } from "next/server";
import fs from "node:fs";
<<<<<<< HEAD
import { settings } from "@/lib/server/config";
import * as ingest from "@/lib/server/ingest";
import { resolveIn, ApiError } from "@/lib/server/uploads";
import { AuthError, audit, requireUser } from "@/lib/server/auth";
=======
import { settings } from "@/lib/config";
import * as ingest from "@/lib/ingest";
import { resolveIn, ApiError } from "@/lib/uploads";
import { AuthError, audit, requireUser } from "@/lib/auth";
>>>>>>> 32f2f75

/** Deletes the file; its passages are dropped from the index in the background (no re-embedding). */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path") ?? "";
  try {
    const user = requireUser(req, "editor");
    const target = resolveIn(settings.frameworksDir, p);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return NextResponse.json({ detail: "No such framework document." }, { status: 404 });
    }
    fs.unlinkSync(target);
    ingest.scheduleSync();
    audit(user.email, "kb_delete", { path: p });
    return NextResponse.json({ deleted: p, status: ingest.statusReport() });
  } catch (exc) {
    if (exc instanceof AuthError || exc instanceof ApiError) {
      return NextResponse.json({ detail: exc.message }, { status: exc.status });
    }
    throw exc;
  }
}
