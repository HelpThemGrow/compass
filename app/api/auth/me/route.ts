import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    return NextResponse.json({ user: requireUser(req) });
  } catch (exc) {
    if (exc instanceof AuthError) return NextResponse.json({ detail: exc.message }, { status: exc.status });
    throw exc;
  }
}
