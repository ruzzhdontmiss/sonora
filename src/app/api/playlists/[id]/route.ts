import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import {
  getPlaylistById,
  updatePlaylist,
  archivePlaylist,
  restorePlaylist,
  deletePlaylist,
} from "@/modules/playlists/playlists.service";
import { ConcurrencyConflictError, NotFoundError } from "@/modules/common/errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, props: RouteParams) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await props.params;

  try {
    const playlist = await getPlaylistById(session.user.id, id);
    return NextResponse.json({ success: true, playlist });
  } catch (err: unknown) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request, props: RouteParams) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await props.params;

  try {
    const body = await request.json();
    const expectedVersion =
      typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;

    // Handle archive / restore actions
    if (body.action === "ARCHIVE") {
      const archived = await archivePlaylist(session.user.id, id, expectedVersion);
      return NextResponse.json({ success: true, playlist: archived });
    }

    if (body.action === "RESTORE") {
      const restored = await restorePlaylist(session.user.id, id, expectedVersion);
      return NextResponse.json({ success: true, playlist: restored });
    }

    const updated = await updatePlaylist(
      session.user.id,
      id,
      {
        title: body.title,
        description: body.description,
        isPublic: body.isPublic,
      },
      expectedVersion
    );

    return NextResponse.json({ success: true, playlist: updated });
  } catch (err: unknown) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Failed to update playlist";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request, props: RouteParams) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await props.params;

  try {
    await deletePlaylist(session.user.id, id);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Failed to delete playlist";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
