/**
 * Shared upload helpers for API routes. Port of the file-handling utilities
 * in app/main.py (_safe_name, _write_capped/_save_upload, _resolve_in).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SUPPORTED } from "./extract";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function safeName(name: string): string {
  const stem = path.basename(name || "upload");
  const cleaned = [...stem].map((ch) => (/[A-Za-z0-9\-_. ]/.test(ch) ? ch : "_")).join("");
  return cleaned.slice(0, 120) || "upload";
}

/** Save a browser File to `targetDir`, refusing anything past MAX_UPLOAD_BYTES or an unsupported extension. */
export async function saveUpload(file: File, targetDir: string): Promise<string> {
  const suffix = path.extname(file.name || "").toLowerCase();
  if (!SUPPORTED.has(suffix)) {
    throw new ApiError(400, `Unsupported file type '${suffix || "unknown"}'. Allowed: ${[...SUPPORTED].sort().join(", ")}`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit.`);
  }
  if (file.size === 0) {
    throw new ApiError(400, "The uploaded file is empty.");
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const name = safeName(file.name || `upload${suffix}`);
  const dest = path.join(targetDir, `${crypto.randomBytes(4).toString("hex")}_${name}`);
  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

/** Resolve a user-supplied relative path, refusing anything outside `base`. */
export function resolveIn(base: string, relative: string): string {
  const resolvedBase = path.resolve(base);
  const candidate = path.resolve(resolvedBase, relative);
  if (candidate !== resolvedBase && !candidate.startsWith(resolvedBase + path.sep)) {
    throw new ApiError(400, "Invalid path.");
  }
  return candidate;
}
