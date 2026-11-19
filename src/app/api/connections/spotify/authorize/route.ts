import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import {
  generateSpotifyAuthorizeUrl,
  getSpotifyConfigStatus,
  SPOTIFY_FULL_SCOPES,
  SPOTIFY_READONLY_SCOPES,
} from "@/modules/providers/spotify/spotify-auth.service";

export async function GET(request: NextRequest) {
  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.json(
        { error: "Authentication required to connect Spotify." },
        { status: 401 }
      );
    }

    const configStatus = getSpotifyConfigStatus();
    if (!configStatus.isConfigured) {
      return NextResponse.json(
        {
          error: "Spotify integration is not configured in this environment.",
          missingVariables: configStatus.missingVariables,
          configured: false,
        },
        { status: 503 }
      );
    }

    const host = request.headers.get("host") || undefined;
    const scopeParam = request.nextUrl.searchParams.get("scope");
    const scopes = scopeParam === "readonly" ? SPOTIFY_READONLY_SCOPES : SPOTIFY_FULL_SCOPES;
    const { url } = await generateSpotifyAuthorizeUrl(auth.user.id, host, scopes);

    // If client requested JSON via Accept header
    const acceptHeader = request.headers.get("accept") || "";
    if (acceptHeader.includes("application/json")) {
      return NextResponse.json({ url });
    }

    // Direct browser redirect
    return NextResponse.redirect(url);
  } catch (err: unknown) {
    console.error("Error generating Spotify authorization URL:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to initiate Spotify connection." },
      { status: 500 }
    );
  }
}
