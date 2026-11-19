import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { createPlaylist, getUserPlaylists } from "@/modules/playlists/playlists.service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = parseInt(url.searchParams.get("limit") || "25", 10);
  const search = url.searchParams.get("search") || undefined;
  const includeArchived = url.searchParams.get("includeArchived") === "true";

  try {
    const result = await getUserPlaylists(session.user.id, {
      page,
      limit,
      search,
      includeArchived,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch playlists";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const playlist = await createPlaylist(session.user.id, {
      title: body.title,
      description: body.description,
      isPublic: body.isPublic,
    });

    return NextResponse.json({ success: true, playlist }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create playlist";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
