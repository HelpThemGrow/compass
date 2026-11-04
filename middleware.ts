import { NextResponse, type NextRequest } from "next/server";
import { sessionUser } from "@/lib/auth";

// Every page and API route requires a signed-in user, except the sign-in
// page itself and the two assets it shows. Editor-only routes additionally
// check the role themselves (lib/auth.ts requireUser).
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/vibha-logo.png"]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // Cross-site request forgery: a state-changing request must come from this
  // site. Browsers always send Origin on cross-site POST/DELETE.
  if (isApi && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameSite(req)) {
    return NextResponse.json({ detail: "Request blocked: it did not come from this site." }, { status: 403 });
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (sessionUser(req.headers.get("cookie"))) return NextResponse.next();

  if (isApi) return NextResponse.json({ detail: "Please sign in." }, { status: 401 });
  const login = new URL("/login", req.url);
  if (pathname !== "/") login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

function sameSite(req: NextRequest): boolean {
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (!source) return false;
  try {
    return new URL(source).host === req.headers.get("host");
  } catch {
    return false; // "null" or malformed
  }
}

export const config = {
  runtime: "nodejs",
  // Static build assets and the dev server's live-reload channel stay open;
  // everything else, including /_next/image, goes through the check above.
  matcher: ["/((?!_next/static|_next/webpack-hmr|__nextjs|favicon.ico).*)"],
};
