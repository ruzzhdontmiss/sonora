# Apple Music Provider Capabilities & Write Semantics

This document outlines the verified technical capabilities, rate limits, write semantics, and API behaviors for Apple Music integrations in SONORA.

---

## 1. Authentication & Tokens

Apple Music API requires a two-tiered token architecture:

1. **Developer Token (JWT)**:
   - Generated server-side using the developer team's ES256 private key (`.p8`), Key ID, and Team ID.
   - Passed in the `Authorization: Bearer <jwt>` HTTP header.
   - Never exposed to client browsers or logged.

2. **Music User Token (MUT)**:
   - Acquired client-side via MusicKit JS `musicKit.authorize()`.
   - Delivered securely to the server and encrypted at rest in PostgreSQL (`provider_accounts.encryptedAccessToken`).
   - Passed in the `Music-User-Token: <token>` HTTP header.
   - Authorizes mutations to the specific user's personal Cloud Music Library.

---

## 2. Write Semantics & Batching Limits

### Library Playlist Creation
- **Endpoint**: `POST https://api.music.apple.com/v1/me/library/playlists`
- **Headers**:
  - `Authorization: Bearer <developer_token>`
  - `Music-User-Token: <music_user_token>`
  - `Content-Type: application/json`
- **Body**:
  ```json
  {
    "attributes": {
      "name": "My Migrated Playlist",
      "description": "Migrated by SONORA"
    }
  }
  ```
- **Returns**: Resource object containing created playlist `id` (e.g. `p.xxxxxx`).

### Track Addition to Library Playlist
- **Endpoint**: `POST https://api.music.apple.com/v1/me/library/playlists/{playlist_id}/tracks`
- **Batch Size Limit**: Maximum **100 track objects per request**.
- **Body**:
  ```json
  {
    "data": [
      { "id": "123456789", "type": "songs" },
      { "id": "987654321", "type": "songs" }
    ]
  }
  ```
- **Storefront Requirement**: Track IDs must be valid catalog song IDs for the user's active storefront (e.g. `us`, `gb`, `jp`).

### Library Song Addition (Saved / Liked Songs)
- **Endpoint**: `POST https://api.music.apple.com/v1/me/library?ids[songs]={comma_separated_ids}`
- **Batch Size Limit**: Maximum **25 song IDs per request**.
- **Semantics**: Adds songs to user's Cloud Music Library; idempotent.

---

## 3. Rate Limiting & Throttling

- **Status Code**: `429 Too Many Requests`
- **Header**: `Retry-After: <seconds>` (or standard HTTP 429)
- **Adapter Strategy**:
  - Automatically respects `Retry-After`.
  - Implements exponential backoff: 2s, 5s, 10s.
  - Maximum retry attempts: 3.
  - Sequential batch execution to prevent Cloud Music Library ingestion collisions.

---

## 4. Read-Back Verification

After writing tracks, the adapter reads back library playlist items via `GET /v1/me/library/playlists/{playlist_id}/tracks` to verify:
1. Total track count matches expected count.
2. Reports any catalog items rejected by Apple's Cloud Library.
