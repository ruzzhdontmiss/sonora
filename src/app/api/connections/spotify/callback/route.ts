import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { handleSpotifyCallback } from "@/modules/providers/spotify/spotify-auth.service";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const baseUrl = `${url.protocol}//${url.host}`;

  if (error) {
    console.warn(`Spotify OAuth returned error from provider: ${error}`);
    return NextResponse.redirect(
      `${baseUrl}/dashboard/connections?error=${encodeURIComponent(`Spotify denied access: ${error}`)}`
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${baseUrl}/dashboard/connections?error=${encodeURIComponent("Missing authorization code or state from Spotify callback.")}`
    );
  }

  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.redirect(
        `${baseUrl}/login?redirect=${encodeURIComponent("/dashboard/connections")}&error=session_expired`
      );
    }

    const host = request.headers.get("host") || undefined;
    await handleSpotifyCallback(code, state, auth.user.id, host);

    return NextResponse.redirect(
      `${baseUrl}/dashboard/connections?connected=spotify`
    );
  } catch (err: unknown) {
    console.error("Spotify OAuth callback error:", err instanceof Error ? err.message : err);
    const message = err instanceof Error ? err.message : "Failed to complete Spotify connection.";
    return NextResponse.redirect(
      `${baseUrl}/dashboard/connections?error=${encodeURIComponent(message)}`
    );
  }
}
