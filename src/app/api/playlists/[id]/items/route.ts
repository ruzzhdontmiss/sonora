import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { addPlaylistItem } from "@/modules/playlists/playlists.service";
import { ConcurrencyConflictError, NotFoundError } from "@/modules/common/errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, props: RouteParams) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: playlistId } = await props.params;

  try {
    const body = await request.json();
    const { trackId, position, notes, expectedVersion } = body;

    if (!trackId) {
      return NextResponse.json({ error: "trackId is required" }, { status: 400 });
    }

    const item = await addPlaylistItem(
      session.user.id,
      playlistId,
      {
        trackId,
        position,
        notes,
      },
      expectedVersion
    );

    return NextResponse.json({ success: true, item }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Failed to add playlist item";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
