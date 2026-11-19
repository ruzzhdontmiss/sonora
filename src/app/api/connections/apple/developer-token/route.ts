import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import {
  getAppleConfigStatus,
  getAppleDeveloperToken,
} from "@/modules/providers/apple/apple-token.service";

export async function GET(request: NextRequest) {
  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.json(
        { error: "Authentication required to access Apple Music developer token." },
        { status: 401 }
      );
    }

    const configStatus = getAppleConfigStatus();
    if (!configStatus.isConfigured) {
      return NextResponse.json(
        {
          configured: false,
          error: "Apple Music integration is not configured in this environment.",
          missingVariables: configStatus.missingVariables,
        },
        { status: 503 }
      );
    }

    const developerToken = await getAppleDeveloperToken();

    return NextResponse.json({
      configured: true,
      developerToken,
      storefront: "us",
    });
  } catch (err: unknown) {
    console.error("Failed to generate Apple Developer Token:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate Apple Music developer token." },
      { status: 500 }
    );
  }
}
