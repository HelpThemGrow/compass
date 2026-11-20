import { NextResponse } from "next/server";
import { audit, clearedSessionCookie, isHttps, sessionUser } from "@/lib/server/auth";

export async function POST(req: Request) {
  const user = sessionUser(req.headers.get("cookie"));
  if (user) audit(user.email, "logout");
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearedSessionCookie(isHttps(req)));
  return res;
}
