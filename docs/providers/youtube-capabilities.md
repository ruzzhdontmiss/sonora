# YouTube Data API v3 & YouTube Music Capabilities

This document outlines the verified technical capabilities, quota costs, rate limits, write semantics, and architectural boundaries for YouTube / YouTube Music integrations in SONORA.

---

## 1. Product Positioning & Non-Parity Declarations

SONORA integrates with the official **Google YouTube Data API v3**. The YouTube Data API is an API for the broader YouTube video platform and **not** a 1:1 personal library API for YouTube Music.

### Supported Operations (via YouTube Data API v3)
- Read user's public and private YouTube playlists and playlist items (`playlists.list`, `playlistItems.list`).
- Read user's liked videos with category filtering for music tracks (`videos.list?myRating=like` with `categoryId=10`).
- Dynamically discover liked playlist ID via channel metadata (`channels.list?mine=true&part=contentDetails` -> `relatedPlaylists.likes`).
- Create user playlists (`playlists.insert`).
- Sequentially add tracks/videos to user playlists (`playlistItems.insert`).
- Rate tracks as liked (`videos.rate?rating=like`).
- Search YouTube video catalog (`search.list` combined with `videos.list`).

### Unsupported Operations (Explicit Non-Parity)
- **Saved Albums (`canReadSavedAlbums: false`, `canWriteSavedAlbums: false`):** The YouTube Data API does not expose native YouTube Music saved albums or album library membership.
- **Incremental Sync / Webhooks (`supportsIncrementalSync: false`):** YouTube does not provide push notifications or sync tokens for personal user library changes. Polling is strictly bounded and quota-aware.
- **Native Cloud Locker Uploads:** Personal audio file uploads stored in YouTube Music locker cannot be read or written via the public API.
- **Unofficial Innertube / ytmusicapi:** SONORA strictly rejects scraping, browser cookies (`SAPISIDHASH`), and unofficial Innertube endpoints (`youtubei/v1`).

---

## 2. Authentication & Scopes

YouTube integration uses Google OAuth 2.0 Authorization Code flow with RFC 7636 PKCE (`S256` code challenge).

- **Scopes:**
  - `openid email profile`: Basic user identification.
  - `https://www.googleapis.com/auth/youtube`: Full YouTube management (required for creating playlists, inserting playlist items, and rating videos).
  - `https://www.googleapis.com/auth/youtube.readonly`: Read-only access for import workflows.
- **Token Storage & Security:**
  - Tokens are encrypted at rest using AES-256-GCM.
  - Concurrency control: Token refreshes acquire a distributed optimistic lease (`refreshLockToken` with 30s timeout) to prevent token stampedes across workers.
  - Revocation: Disconnecting an account triggers server-side revocation against `https://oauth2.googleapis.com/revoke`.
- **Testing Mode Note:** In Google Cloud "Testing" OAuth mode, refresh tokens expire after 7 days. SONORA detects expired tokens, marks accounts as `EXPIRED`, and prompts re-authentication.

---

## 3. Dual-Bucket Quota Model

YouTube Data API v3 enforces daily quotas calculated in units, resetting at **Midnight Pacific Time (`America/Los_Angeles`)**.

SONORA models quota using two independent buckets:

| Quota Bucket | Default Allocation | Operations & Unit Costs | Notes |
|---|---|---|---|
| **Search Queries** | **100 calls / day** | `search.list`: **1 unit** | Consumes 0 units from General bucket. Dedicated pool. |
| **General Quota** | **10,000 units / day** | `playlists.insert`: **50 units**<br/>`playlistItems.insert`: **50 units**<br/>`videos.rate`: **50 units**<br/>`playlists.list`: **1 unit** (page of 50)<br/>`playlistItems.list`: **1 unit** (page of 50)<br/>`videos.list`: **1 unit** (batch of 50)<br/>`channels.list`: **1 unit** | Search queries do NOT consume from this pool. |

### Quota Lifecycle & Guarantees
1. **Reservation:** Before dispatching an expensive migration or search, workers reserve quota with a 300-second lease.
2. **Crash Recovery:** If a background worker terminates abnormally, uncommitted reservations automatically expire and are reclaimed by the quota manager.
3. **Idempotency:** Replay requests with the same idempotency key reuse existing reservations without double-charging.
4. **Day-Boundary Transitions:** The quota manager calculates elapsed seconds until Pacific Time midnight with daylight saving awareness (`Intl.DateTimeFormat`).

---

## 4. Destination Write Semantics & Prefix Safeguard

Unlike Spotify and Apple Music, the YouTube Data API does **not** provide batch playlist insertion (items must be inserted 1-by-1 at 50 units each) and provides no native request idempotency key.

### Write Operations:
- **Create Playlist:** `POST https://www.googleapis.com/youtube/v3/playlists?part=snippet,status` (50 units).
- **Add Track:** `POST https://www.googleapis.com/youtube/v3/playlistItems?part=snippet` (50 units).
- **Rate as Liked:** `POST https://www.googleapis.com/youtube/v3/videos/rate?rating=like&id={videoId}` (50 units).

### Dual-Read Prefix Verification (Safeguard on Uncertain Results)
When a network drop, timeout, or HTTP 5xx occurs during `playlistItems.insert`:
1. The operation is not immediately re-inserted.
2. The orchestrator executes a full paginated read of the destination playlist (`GET /playlistItems?playlistId=...`).
3. After 500ms, a second read is executed to ensure eventual consistency on YouTube's backend.
4. The verified ordered prefix is compared against the migration plan.
5. If the item was successfully written despite the network drop, the insertion is marked complete. If absent, it is safely re-attempted. If external discrepancies exist, the job halts safely for manual review.

---

## 5. Google Data Portability API (Auxiliary Importer)

For users in eligible regions, SONORA provides an auxiliary import path leveraging the **Google Data Portability API** (`dataportability.googleapis.com`):

- **Scope:** `https://www.googleapis.com/auth/dataportability.youtube.music` (classified as Sensitive).
- **Geographic Eligibility:** Restricted to EEA (27 EU countries + IS, LI, NO), UK (GB), Switzerland (CH), and US. Other countries (including India) are explicitly denied with clear messaging.
- **In-Memory Streaming Extraction:** Archives are streamed into memory; Zip-Slip path traversal (`..` or absolute paths) and zip bomb decompression limits (max 50MB per file) are strictly enforced.
- **Ephemeral Cleanup:** Buffers are zeroed and cleaned immediately in `finally` blocks; archive URLs are never logged.
