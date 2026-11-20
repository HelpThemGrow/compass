import { NextResponse } from "next/server";
<<<<<<< HEAD
import * as llm from "@/lib/server/llm";
import { embedderStatus } from "@/lib/server/embeddings";
import * as ingest from "@/lib/server/ingest";
import * as rubric from "@/lib/server/rubric";
import { summary } from "@/lib/server/rubric";
import { SUPPORTED } from "@/lib/server/extract";
=======
import * as llm from "@/lib/llm";
import { embedderStatus } from "@/lib/embeddings";
import * as ingest from "@/lib/ingest";
import * as rubric from "@/lib/rubric";
import { summary } from "@/lib/rubric";
import { SUPPORTED } from "@/lib/extract";
>>>>>>> 32f2f75

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
