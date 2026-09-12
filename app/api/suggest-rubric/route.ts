import { NextResponse } from "next/server";
import fs from "node:fs";
import { settings } from "@/lib/config";
import { extract, wordCount } from "@/lib/extract";
import * as rubric from "@/lib/rubric";
import { saveUpload, ApiError } from "@/lib/uploads";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ detail: "A file is required." }, { status: 400 });

  let p: string | null = null;
  try {
    p = await saveUpload(file, settings.uploadsDir);
    const doc = await extract(p);
    return NextResponse.json({ suggestions: rubric.suggest(doc.text), word_count: wordCount(doc) });
  } catch (exc) {
    if (exc instanceof ApiError) return NextResponse.json({ detail: exc.message }, { status: exc.status });
    return NextResponse.json({ detail: (exc as Error).message }, { status: 500 });
  } finally {
    if (p) fs.unlink(p, () => {});
  }
}
