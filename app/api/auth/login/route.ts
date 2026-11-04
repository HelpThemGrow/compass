import { NextResponse } from "next/server";
import { AuthError, clientIp, createSessionToken, hasAccounts, isHttps, login, sessionCookie } from "@/lib/auth";

export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({}));
  const email = String(payload.email ?? "").trim();
  const password = String(payload.password ?? "");
  if (!email || !password) return NextResponse.json({ detail: "Enter your email and password." }, { status: 400 });
  if (!hasAccounts()) {
    return NextResponse.json(
      { detail: "No accounts have been created yet. An administrator can create one with: npm run users -- add <email> editor" },
      { status: 503 }
    );
  }
  try {
    const user = login(email, password, clientIp(req));
    const { token, maxAge } = createSessionToken(user);
    const res = NextResponse.json({ user });
    res.headers.set("Set-Cookie", sessionCookie(token, maxAge, isHttps(req)));
    return res;
  } catch (exc) {
    if (exc instanceof AuthError) return NextResponse.json({ detail: exc.message }, { status: exc.status });
    throw exc;
  }
}
