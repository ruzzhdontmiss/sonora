import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { disconnectAppleMusicAccount } from "@/modules/providers/apple/apple-auth.service";
import { z } from "zod";

const disconnectSchema = z.object({
  providerAccountId: z.string().uuid("Invalid provider account identifier"),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const parseResult = disconnectSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    await disconnectAppleMusicAccount(parseResult.data.providerAccountId, auth.user.id);

    return NextResponse.json({
      success: true,
      message: "Apple Music account disconnected successfully. Canonical library and playlists preserved.",
    });
  } catch (err: unknown) {
    console.error("Apple Music disconnect error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to disconnect Apple Music account." },
      { status: 500 }
    );
  }
}
