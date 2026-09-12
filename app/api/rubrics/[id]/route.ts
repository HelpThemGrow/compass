import { NextResponse } from "next/server";
import * as rubric from "@/lib/rubric";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let r;
  try {
    r = rubric.get(id);
  } catch (exc) {
    return NextResponse.json({ detail: (exc as Error).message }, { status: 404 });
  }
  return NextResponse.json({
    ...rubric.summary(r),
    sections: r.sections.map((s) => ({ id: s.id, title: s.title, required: s.required, aliases: s.aliases })),
    checks: r.checks.map((c) => ({ id: c.id, description: c.description, severity: c.severity })),
    criteria: r.dimensions.flatMap((d) =>
      d.criteria.map((c) => ({
        id: c.id,
        dimension: d.name,
        requirement: c.requirement,
        weight: c.weight,
        critical: c.critical,
        framework_refs: c.framework_refs,
      }))
    ),
  });
}
