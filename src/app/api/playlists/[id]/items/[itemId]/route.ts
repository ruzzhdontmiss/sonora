import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { removePlaylistItem } from "@/modules/playlists/playlists.service";
import { ConcurrencyConflictError, NotFoundError } from "@/modules/common/errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; itemId: string }>;
}

export async function DELETE(request: Request, props: RouteParams) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: playlistId, itemId } = await props.params;

  try {
    const url = new URL(request.url);
    const versionParam = url.searchParams.get("expectedVersion");
    const expectedVersion = versionParam ? parseInt(versionParam, 10) : undefined;

    await removePlaylistItem(session.user.id, playlistId, itemId, expectedVersion);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Failed to remove playlist item";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
