# Spotify Provider Capabilities & Write Semantics

This document outlines the verified technical capabilities, rate limits, write semantics, and API behaviors for Spotify integrations in SONORA.

---

## 1. Authentication & Scopes

Spotify requires OAuth 2.0 Authorization Code flow with PKCE or client secret.
For write operations, the following scopes must be granted by the user:

- `playlist-modify-public`: Required to create and mutate public playlists.
- `playlist-modify-private`: Required to create and mutate private/collaborative playlists.
- `user-library-modify`: Required to add tracks to the user's Liked Songs library collection (`PUT /v1/me/library`).
- `user-library-read`: Required to check item membership in the user's library (`GET /v1/me/library/contains`) and read Liked Songs for reconciliation.
- `playlist-read-private`: Required to read private playlists and verify playlist contents.

If a requested write operation is attempted without the corresponding granted scope, the adapter rejects the operation upfront with a `ProviderAuthenticationError` without making network calls.

---

## 2. Write Semantics & Batching Limits

### Playlist Creation
- **Endpoint**: `POST https://api.spotify.com/v1/me/playlists`
- **Body**:
  ```json
  {
    "name": "My Migrated Playlist",
    "description": "Migrated by SONORA",
    "public": false
  }
  ```
- **Returns**: Playlist object containing `id`, `uri` (`spotify:playlist:{id}`), and external URL.

### Track Addition to Playlist
- **Endpoint**: `POST https://api.spotify.com/v1/playlists/{playlist_id}/items` (Replaces deprecated `/tracks`)
- **Batch Size Limit**: Maximum **100 track URIs per request**.
- **Body**:
  ```json
  {
    "uris": ["spotify:track:...", "..."],
    "position": 0
  }
  ```
- **Duplicate Tracks**: Spotify supports and natively preserves duplicate track occurrences in playlists when URIs appear multiple times in `uris`.
- **Ordering**: Tracks are inserted sequentially in the exact order specified in the array.

### Liked Songs Addition
- **Endpoint**: `PUT https://api.spotify.com/v1/me/library?uris={comma_separated_uris}` (Replaces deprecated `/v1/me/tracks`)
- **Checking Membership**: `GET https://api.spotify.com/v1/me/library/contains?uris={comma_separated_uris}`
- **Batch Size Limit**: Maximum **40 track URIs per request**.
- **Semantics**: Idempotent; existing items are checked prior to dispatch to skip redundant writes. If uncertain network errors occur, membership is queried via `/contains` to reconcile status before any retry.

---

## 3. Rate Limiting & Throttling

- **Status Code**: `429 Too Many Requests`
- **Header**: `Retry-After: <seconds>`
- **Adapter Strategy**:
  - Automatically parses the `Retry-After` header.
  - Implements exponential backoff with jitter when no header is present (default: 2s, 4s, 8s).
  - Maximum retry attempts: 3.
  - Bounded concurrency: maximum 3 concurrent write requests per account.

---

## 4. Read-Back Verification

After writing all batches, the adapter reads back playlist items via `GET /v1/playlists/{playlist_id}/items?limit=100` to verify:
1. Total item count matches expected added count.
2. No silent truncation occurred.
