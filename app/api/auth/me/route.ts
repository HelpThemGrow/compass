import { NextResponse } from "next/server";
<<<<<<< HEAD
import { AuthError, requireUser } from "@/lib/server/auth";
=======
import { AuthError, requireUser } from "@/lib/auth";
>>>>>>> 32f2f75

export async function GET(req: Request) {
  try {
    return NextResponse.json({ user: requireUser(req) });
  } catch (exc) {
    if (exc instanceof AuthError) return NextResponse.json({ detail: exc.message }, { status: exc.status });
    throw exc;
  }
}
