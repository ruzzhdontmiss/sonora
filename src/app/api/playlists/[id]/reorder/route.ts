import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { reorderPlaylistItems } from "@/modules/playlists/playlists.service";
import { ConcurrencyConflictError, NotFoundError, ValidationError } from "@/modules/common/errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PUT(request: Request, props: RouteParams) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: playlistId } = await props.params;

  try {
    const body = await request.json();
    const { itemIds, expectedVersion } = body;

    if (!Array.isArray(itemIds)) {
      return NextResponse.json({ error: "itemIds array is required" }, { status: 400 });
    }

    const reorderedItems = await reorderPlaylistItems(
      session.user.id,
      playlistId,
      itemIds,
      expectedVersion
    );

    return NextResponse.json({ success: true, items: reorderedItems });
  } catch (err: unknown) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Failed to reorder playlist";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
