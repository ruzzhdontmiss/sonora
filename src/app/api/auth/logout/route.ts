import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { invalidateSession, SESSION_COOKIE_NAME } from "@/modules/auth/service";
import { validateRequestOrigin } from "@/lib/csrf";

// Explicitly reject GET to ensure logout is never triggered by a top-level link or prefetch
export async function GET() {
  return NextResponse.json({ error: "Method not allowed. Logout requires POST." }, { status: 405 });
}

export async function POST(request: Request) {
  // CSRF Origin Validation on state-changing logout
  if (!validateRequestOrigin(request)) {
    return NextResponse.json(
      { error: "Cross-origin request rejected (CSRF protection)" },
      { status: 403 }
    );
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (sessionToken) {
    await invalidateSession(sessionToken);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
