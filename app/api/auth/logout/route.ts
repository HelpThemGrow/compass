import { NextResponse } from "next/server";
<<<<<<< HEAD
import { audit, clearedSessionCookie, isHttps, sessionUser } from "@/lib/server/auth";
=======
import { audit, clearedSessionCookie, isHttps, sessionUser } from "@/lib/auth";
>>>>>>> 32f2f75

export async function POST(req: Request) {
  const user = sessionUser(req.headers.get("cookie"));
  if (user) audit(user.email, "logout");
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearedSessionCookie(isHttps(req)));
  return res;
}
