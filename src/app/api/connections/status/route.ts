import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { prisma } from "@/lib/db";
import { getSpotifyConfigStatus } from "@/modules/providers/spotify/spotify-auth.service";
import { getAppleConfigStatus } from "@/modules/providers/apple/apple-token.service";
import { ProviderAccountStatus, ProviderType, SyncJobType } from "@prisma/client";

export async function GET(request: NextRequest) {
  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const spotifyConfig = getSpotifyConfigStatus();
    const appleConfig = getAppleConfigStatus();

    // Fetch user's provider accounts
    const accounts = await prisma.providerAccount.findMany({
      where: {
        userId: auth.user.id,
      },
      select: {
        id: true,
        provider: true,
        providerUserId: true,
        displayName: true,
        email: true,
        status: true,
        scopes: true,
        updatedAt: true,
      },
    });

    const spotifyAccount = accounts.find(
      (a) => a.provider === ProviderType.SPOTIFY && a.status === ProviderAccountStatus.CONNECTED
    ) || null;

    const appleAccount = accounts.find(
      (a) => a.provider === ProviderType.APPLE_MUSIC && a.status === ProviderAccountStatus.CONNECTED
    ) || null;

    // Fetch latest import jobs for each provider
    const [latestSpotifyJob, latestAppleJob] = await Promise.all([
      prisma.syncJob.findFirst({
        where: {
          userId: auth.user.id,
          sourceProvider: ProviderType.SPOTIFY,
          jobType: SyncJobType.IMPORT,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.syncJob.findFirst({
        where: {
          userId: auth.user.id,
          sourceProvider: ProviderType.APPLE_MUSIC,
          jobType: SyncJobType.IMPORT,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return NextResponse.json({
      spotify: {
        isConfigured: spotifyConfig.isConfigured,
        missingVariables: spotifyConfig.missingVariables,
        connectedAccount: spotifyAccount,
        lastImportJob: latestSpotifyJob,
      },
      appleMusic: {
        isConfigured: appleConfig.isConfigured,
        missingVariables: appleConfig.missingVariables,
        connectedAccount: appleAccount,
        lastImportJob: latestAppleJob,
      },
      youtubeMusic: {
        isConfigured: false,
        missingVariables: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        connectedAccount: null,
        lastImportJob: null,
        note: "YouTube Data API v3 integration scheduled for Phase 5.",
      },
    });
  } catch (err: unknown) {
    console.error("Connections status error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load connection status." },
      { status: 500 }
    );
  }
}
