import { NextResponse } from "next/server";
import fs from "node:fs";
import * as generation from "@/lib/generation";

const VALID = /^[0-9a-f]{1,32}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!VALID.test(id)) return NextResponse.json({ detail: "Generated document not found." }, { status: 404 });
  const data = generation.load(id);
  if (!data) return NextResponse.json({ detail: "Generated document not found." }, { status: 404 });

  let outPath: string;
  try {
    outPath = await generation.renderDocx(data);
  } catch (exc) {
    return NextResponse.json({ detail: `Could not build the Word document: ${(exc as Error).message}` }, { status: 500 });
  }

  const safeName = (data.doc_name ?? "document").replace(/[^A-Za-z0-9\-_ ]/g, "_");
  const buf = fs.readFileSync(outPath);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${safeName}_${id}.docx"`,
    },
  });
}
