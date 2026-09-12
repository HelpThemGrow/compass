import { NextResponse } from "next/server";
import fs from "node:fs";
import { settings } from "@/lib/config";
import { extract } from "@/lib/extract";
import * as rubric from "@/lib/rubric";
import * as evaluator from "@/lib/evaluate";
import * as llm from "@/lib/llm";
import { saveUpload, ApiError } from "@/lib/uploads";

export const maxDuration = 300;

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ detail: "A file is required." }, { status: 400 });
  const rubricId = String(form.get("rubric_id") ?? "auto");
  const skipLlm = String(form.get("skip_llm") ?? "false") === "true";
  const evidencePerCriterion = parseInt(String(form.get("evidence_per_criterion") ?? "3"), 10) || 3;

  let p: string | null = null;
  try {
    p = await saveUpload(file, settings.uploadsDir);
    const doc = await extract(p);
    if (!doc.text.trim()) {
      return NextResponse.json({ detail: "No text could be read from this file. If it is a scanned PDF, run OCR first." }, { status: 400 });
    }

    const suggestions = rubric.suggest(doc.text);
    let chosen = rubricId;
    if (rubricId === "" || rubricId === "auto") {
      if (!suggestions.length) return NextResponse.json({ detail: "No rubrics are defined. Add a YAML file under rubrics/." }, { status: 400 });
      chosen = suggestions[0].id;
    }

    let selected;
    try {
      selected = rubric.get(chosen);
    } catch (exc) {
      return NextResponse.json({ detail: (exc as Error).message }, { status: 400 });
    }

    try {
      const result = await evaluator.evaluate(doc, selected, {
        filename: file.name || "upload",
        evidencePerCriterion: Math.max(1, Math.min(6, evidencePerCriterion)),
        skipLlm,
        rubricSuggestions: suggestions,
        autoSelected: rubricId === "" || rubricId === "auto",
      });
      return NextResponse.json(result);
    } catch (exc) {
      if (exc instanceof llm.BudgetExhausted) return NextResponse.json({ detail: exc.message }, { status: 429 });
      if (exc instanceof llm.LLMUnavailable || exc instanceof llm.AccessDenied) {
        return NextResponse.json({ detail: exc.message }, { status: 503 });
      }
      throw exc;
    }
  } catch (exc) {
    if (exc instanceof ApiError) return NextResponse.json({ detail: exc.message }, { status: exc.status });
    return NextResponse.json({ detail: (exc as Error).message }, { status: 500 });
  } finally {
    if (p) fs.unlink(p, () => {});
  }
}
