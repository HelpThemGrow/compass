import { NextResponse } from "next/server";
import fs from "node:fs";
import { settings } from "@/lib/config";
import * as ingest from "@/lib/ingest";
import { resolveIn, ApiError } from "@/lib/uploads";

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path") ?? "";
  try {
    const target = resolveIn(settings.frameworksDir, p);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return NextResponse.json({ detail: "No such framework document." }, { status: 404 });
    }
    fs.unlinkSync(target);
    return NextResponse.json({ deleted: p, status: await ingest.rebuild() });
  } catch (exc) {
    if (exc instanceof ApiError) return NextResponse.json({ detail: exc.message }, { status: exc.status });
    throw exc;
  }
}
