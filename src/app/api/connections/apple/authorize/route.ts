import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { saveAppleMusicUserToken } from "@/modules/providers/apple/apple-auth.service";
import { z } from "zod";

const authorizeSchema = z.object({
  musicUserToken: z.string().min(1, "Music user token is required"),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const parseResult = authorizeSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const account = await saveAppleMusicUserToken(
      auth.user.id,
      parseResult.data.musicUserToken
    );

    return NextResponse.json({
      success: true,
      account: {
        id: account.id,
        provider: account.provider,
        displayName: account.displayName,
        status: account.status,
      },
    });
  } catch (err: unknown) {
    console.error("Apple Music authorize error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to authorize Apple Music account." },
      { status: 500 }
    );
  }
}
