import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { handleGoogleCallback } from "@/modules/providers/youtube/youtube-auth.service";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const baseUrl = `${url.protocol}//${url.host}`;

  if (error) {
    console.warn(`Google OAuth returned error from provider: ${error}`);
    return NextResponse.redirect(
      `${baseUrl}/dashboard/connections?error=${encodeURIComponent(`Google denied access: ${error}`)}`
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${baseUrl}/dashboard/connections?error=${encodeURIComponent("Missing authorization code or state from Google callback.")}`
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
    await handleGoogleCallback(code, state, auth.user.id, host);

    return NextResponse.redirect(
      `${baseUrl}/dashboard/connections?connected=youtube`
    );
  } catch (err: unknown) {
    console.error("Google OAuth callback error:", err instanceof Error ? err.message : err);
    const message = err instanceof Error ? err.message : "Failed to complete Google connection.";
    return NextResponse.redirect(
      `${baseUrl}/dashboard/connections?error=${encodeURIComponent(message)}`
    );
  }
}
