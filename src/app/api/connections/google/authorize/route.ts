import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import {
  generateGoogleAuthorizeUrl,
  getGoogleConfigStatus,
  YOUTUBE_FULL_SCOPES,
  YOUTUBE_READONLY_SCOPES,
} from "@/modules/providers/youtube/youtube-auth.service";

export async function GET(request: NextRequest) {
  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.json(
        { error: "Authentication required to connect Google / YouTube." },
        { status: 401 }
      );
    }

    const configStatus = getGoogleConfigStatus();
    if (!configStatus.isConfigured) {
      return NextResponse.json(
        {
          error: "Google integration is not configured in this environment.",
          missingVariables: configStatus.missingVariables,
          configured: false,
        },
        { status: 503 }
      );
    }

    const host = request.headers.get("host") || undefined;
    const scopeParam = request.nextUrl.searchParams.get("scope");
    const includeWriteScopes = scopeParam === "full" || scopeParam === "write";
    const includeDataPortability = request.nextUrl.searchParams.get("dataportability") === "true";

    const scopes = includeWriteScopes ? YOUTUBE_FULL_SCOPES : YOUTUBE_READONLY_SCOPES;
    const { url } = await generateGoogleAuthorizeUrl(auth.user.id, {
      hostOverride: host,
      scopes,
      includeDataPortability,
    });

    const acceptHeader = request.headers.get("accept") || "";
    if (acceptHeader.includes("application/json")) {
      return NextResponse.json({ url });
    }

    return NextResponse.redirect(url);
  } catch (err: unknown) {
    console.error("Error generating Google authorization URL:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to initiate Google connection." },
      { status: 500 }
    );
  }
}
