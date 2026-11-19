import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { ProviderType } from "@prisma/client";
import { getSpotifyAccessTokenForUser } from "@/modules/providers/spotify/spotify-writer.service";
import { getAppleDeveloperToken } from "@/modules/providers/apple/apple-token.service";
import { searchSpotifyCatalog, searchAppleMusicCatalog } from "@/modules/matching/matching-engine";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { query, provider } = body;

    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "Query string is required" }, { status: 400 });
    }

    if (!provider || (provider !== ProviderType.SPOTIFY && provider !== ProviderType.APPLE_MUSIC)) {
      return NextResponse.json(
        { error: "Valid provider (SPOTIFY or APPLE_MUSIC) is required" },
        { status: 400 }
      );
    }

    const userId = session.user.id;

    if (provider === ProviderType.SPOTIFY) {
      const accessToken = await getSpotifyAccessTokenForUser(userId);
      const candidates = await searchSpotifyCatalog(query.trim(), accessToken, 10);
      return NextResponse.json({ success: true, provider, candidates });
    }

    if (provider === ProviderType.APPLE_MUSIC) {
      const devToken = await getAppleDeveloperToken();
      const candidates = await searchAppleMusicCatalog(query.trim(), devToken, "us", 10);
      return NextResponse.json({ success: true, provider, candidates });
    }

    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Catalog search failed";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
