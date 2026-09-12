import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { settings } from "@/lib/config";
import * as ingest from "@/lib/ingest";
import { SUPPORTED } from "@/lib/extract";
import { safeName, resolveIn, MAX_UPLOAD_BYTES } from "@/lib/uploads";

export async function POST(req: Request) {
  const form = await req.formData();
  const folder = String(form.get("folder") ?? "");
  const files = form.getAll("files").filter((f): f is File => f instanceof File);

  let target = settings.frameworksDir;
  if (folder.trim()) target = resolveIn(settings.frameworksDir, safeName(folder.trim()));

  const saved: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const suffix = path.extname(file.name || "").toLowerCase();
      if (!SUPPORTED.has(suffix)) {
        errors.push(`${file.name}: unsupported type`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        errors.push(`${file.name}: exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
        continue;
      }
      fs.mkdirSync(target, { recursive: true });
      const dest = path.join(target, safeName(file.name || "document"));
      fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
      saved.push(path.relative(settings.frameworksDir, dest));
    } catch (exc) {
      errors.push(`${file.name}: ${(exc as Error).message}`);
    }
  }

  const status = saved.length ? await ingest.rebuild() : ingest.statusReport();
  return NextResponse.json({ saved, errors, status });
}
