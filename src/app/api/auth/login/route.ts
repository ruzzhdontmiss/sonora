import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSession, SESSION_COOKIE_NAME } from "@/modules/auth/service";
import { validateRequestOrigin } from "@/lib/csrf";
import { getEnv } from "@/config/env";

const loginSchema = z.object({
  demoUser: z.boolean().optional(),
  email: z.string().optional(),
});

// Explicitly reject GET to ensure no state-changing operations occur on GET
export async function GET() {
  return NextResponse.json({ error: "Method not allowed. Use POST." }, { status: 405 });
}

export async function POST(request: Request) {
  // 1. CSRF Origin / Host Validation
  if (!validateRequestOrigin(request)) {
    return NextResponse.json(
      { error: "Cross-origin request rejected (CSRF protection)" },
      { status: 403 }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: parsed.error.issues.map((i) => i.message) },
        { status: 400 }
      );
    }

    const { email, demoUser } = parsed.data;
    const env = getEnv();

    // 2. Reject ANY email-based submission unconditionally
    // Passwordless account takeover protection:
    // Email-only login without verified ownership or credentials is strictly forbidden.
    if (email !== undefined) {
      return NextResponse.json(
        {
          error:
            "Passwordless email login is disabled. Real authentication will be implemented through an approved provider flow.",
        },
        { status: 403 }
      );
    }

    // 3. Demo login must be explicitly requested
    if (demoUser !== true) {
      return NextResponse.json(
        { error: "Invalid login request. No valid authentication mechanism specified." },
        { status: 400 }
      );
    }

    // 4. Demo authentication permitted ONLY in development when DEMO_AUTH_ENABLED is true
    if (env.NODE_ENV !== "development" || !env.DEMO_AUTH_ENABLED) {
      return NextResponse.json(
        {
          error:
            "Synthetic demo authentication is disabled. It is only permitted when NODE_ENV=development and DEMO_AUTH_ENABLED=true.",
        },
        { status: 403 }
      );
    }

    // 5. Authenticate strictly as the synthetic demo user
    const targetUser = await prisma.user.upsert({
      where: { email: "synthetic-user@example.com" },
      update: {},
      create: {
        id: "00000000-0000-0000-0000-000000000001",
        email: "synthetic-user@example.com",
        displayName: "Synthetic Demo User",
        passwordHash: "synthetic_test_hash",
      },
    });

    const sessionJwt = await createSession(targetUser.id);

    const response = NextResponse.json({
      ok: true,
      user: {
        id: targetUser.id,
        email: targetUser.email,
        displayName: targetUser.displayName,
      },
    });

    response.cookies.set(SESSION_COOKIE_NAME, sessionJwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Authentication error" },
      { status: 500 }
    );
  }
}
