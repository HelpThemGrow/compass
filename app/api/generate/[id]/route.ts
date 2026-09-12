import { NextResponse } from "next/server";
import * as generation from "@/lib/generation";

const VALID = /^[0-9a-f]{1,32}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!VALID.test(id)) return NextResponse.json({ detail: "Generated document not found." }, { status: 404 });
  const data = generation.load(id);
  if (!data) return NextResponse.json({ detail: "Generated document not found." }, { status: 404 });
  return NextResponse.json(data);
}
