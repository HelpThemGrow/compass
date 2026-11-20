import { NextResponse } from "next/server";
import * as llm from "@/lib/server/llm";
import { embedderStatus } from "@/lib/server/embeddings";
import * as ingest from "@/lib/server/ingest";
import * as rubric from "@/lib/server/rubric";
import { summary } from "@/lib/server/rubric";
import { SUPPORTED } from "@/lib/server/extract";

export async function GET() {
  let rubrics: unknown[] = [];
  let rubricError: string | null = null;
  try {
    rubrics = Object.values(rubric.loadAll()).map(summary);
  } catch (exc) {
    rubricError = (exc as Error).message;
  }

  return NextResponse.json({
    llm: llm.health(),
    embeddings: await embedderStatus(),
    framework: ingest.statusReport(),
    rubrics,
    rubric_error: rubricError,
    supported_types: [...SUPPORTED].sort(),
  });
}
