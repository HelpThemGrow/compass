import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { settings } from "@/lib/config";
import * as ingest from "@/lib/ingest";
import * as sensitive from "@/lib/sensitive";
import { SUPPORTED, extract } from "@/lib/extract";
import { safeName, resolveIn, MAX_UPLOAD_BYTES } from "@/lib/uploads";
import { AuthError, audit, requireUser } from "@/lib/auth";

/**
 * Saves the files and returns straight away; only the new files are then
 * embedded in the background. The Knowledge base page polls the status.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = requireUser(req, "editor");
  } catch (exc) {
    if (exc instanceof AuthError) return NextResponse.json({ detail: exc.message }, { status: exc.status });
    throw exc;
  }
  const form = await req.formData();
  const folder = String(form.get("folder") ?? "");
  const files = form.getAll("files").filter((f): f is File => f instanceof File);

  let target = settings.frameworksDir;
  if (folder.trim()) target = resolveIn(settings.frameworksDir, safeName(folder.trim()));

  const saved: string[] = [];
  const errors: string[] = [];
  const warned: string[] = [];
  const refused: { file: string; found: string[] }[] = [];

  for (const file of files) {
    try {
      const suffix = path.extname(file.name || "").toLowerCase();
      if (!SUPPORTED.has(suffix)) {
        errors.push(`${file.name}: unsupported type`);
        continue;
      }
      if (!ingest.isIndexableName(safeName(file.name || ""))) {
        errors.push(`${file.name}: this name is reserved (README.md or an Office temporary file) and would not be indexed`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        errors.push(`${file.name}: exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
        continue;
      }
      if (file.size === 0) {
        errors.push(`${file.name}: the file is empty`);
        continue;
      }
      // Screen a private copy first, so a refused file never lands in the knowledge base.
      const buf = Buffer.from(await file.arrayBuffer());
      let findings;
      try {
        findings = await screen(buf, suffix);
      } catch (exc) {
        errors.push(`${file.name}: could not be read (${(exc as Error).message})`);
        continue;
      }
      if (sensitive.blocking(findings).length) {
        errors.push(`${file.name}: not added. ${sensitive.blockedMessage("It", findings)}`);
        refused.push({ file: safeName(file.name || ""), found: findings.map((f) => f.kind) });
        continue;
      }
      if (findings.length) warned.push(`${file.name}: ${sensitive.warningMessage("It", findings)}`);
      fs.mkdirSync(target, { recursive: true });
      const dest = path.join(target, safeName(file.name || "document"));
      fs.writeFileSync(dest, buf);
      saved.push(path.relative(settings.frameworksDir, dest));
    } catch (exc) {
      errors.push(`${file.name}: ${(exc as Error).message}`);
    }
  }

  if (saved.length) ingest.scheduleSync();
  audit(user.email, "kb_upload", { saved, rejected: errors, sensitive_refused: refused });
  return NextResponse.json({ saved, errors, warnings: warned, status: ingest.statusReport() });
}

/** Extract the text the index would see and screen it. Only counts are kept, never the matches. */
async function screen(buf: Buffer, suffix: string) {
  fs.mkdirSync(settings.uploadsDir, { recursive: true });
  const tmp = path.join(settings.uploadsDir, `${crypto.randomBytes(6).toString("hex")}_screen${suffix}`);
  fs.writeFileSync(tmp, buf);
  try {
    return sensitive.scanText((await extract(tmp)).text);
  } finally {
    fs.unlink(tmp, () => {});
  }
}
