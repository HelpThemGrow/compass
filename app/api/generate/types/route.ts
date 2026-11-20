import { NextResponse } from "next/server";
<<<<<<< HEAD
import * as generation from "@/lib/server/generation";
=======
import * as generation from "@/lib/generation";
>>>>>>> 32f2f75

export async function GET() {
  return NextResponse.json({ types: generation.availableTypes() });
}
