# SONORA Phase-wise Engineering Tickets

**Product:** SONORA --- Universal Music Library\
**Plan:** Five controlled phases; one ticket at a time\
**Primary stack:** Next.js App Router, TypeScript, Tailwind CSS,
PostgreSQL, Prisma\
**Operating rule:** `RULES.md` is mandatory and takes precedence over
convenience.

------------------------------------------------------------------------

## Product scope and non-goals

SONORA is a web application that stores a provider-independent music
library and helps users import, organize, back up, and transfer
supported music metadata and playlist structures between streaming
providers.

Initial providers: - Spotify Web API - Apple Music API + MusicKit JS -
YouTube Data API v3, limited to officially supported YouTube resources
and capabilities

SONORA does not stream, host, download, proxy, or redistribute audio.

**Important feasibility boundary:** YouTube Data API is not a complete
YouTube Music personal-library API. Do not claim full YouTube Music
liked-songs, albums, playlists, or library parity unless a capability is
verified in official documentation and tested. Build a capability-aware
adapter and communicate limitations in the UI.

Spotify Development Mode is restricted. Current official rules require
the app owner to have Premium and allow up to five authorized users;
endpoint access and quotas are restricted. Extended quota is not a
realistic assumption for an individual MVP. Build and test within the
available personal-development constraints. Do not design a commercial
launch plan that assumes extended access will be granted.

Apple Music user-library requests require a developer token and Music
User Token. MusicKit on the Web manages user-token behavior for web
applications.

YouTube playlist item insertion has a quota cost of 50 units per
request. Account for quota before offering large writes.

## Global execution protocol

1.  Read `RULES.md`.
2.  Work on the next unapproved ticket only.
3.  Inspect repository state before editing.
4.  Give a short plan before implementation.
5.  Implement only the ticket scope.
6.  Run the ticket's checks.
7.  Produce the completion report required by `RULES.md`.
8.  Stop and wait for the human review.
9.  Never start the next ticket or phase without explicit approval.

Do not create commits, push branches, create GitHub repositories, or
deploy unless the human explicitly authorizes that action.

## Phase overview

  -----------------------------------------------------------------------
  Phase                   Name                    Outcome
  ----------------------- ----------------------- -----------------------
  1                       Foundation and product  Secure, runnable app
                          shell                   with database and
                                                  dashboard

  2                       Canonical library and   Provider-neutral data
                          provider foundations    model and adapter
                                                  contracts

  3                       Spotify + Apple Music   Two real provider
                          import                  connections and library
                                                  ingestion

  4                       Matching, playlists and Cross-provider matching
                          migration               and reliable transfer

  5                       YouTube capability      Supported YouTube
                          integration, backup and features, portable
                          hardening               backup, production
                                                  readiness
  -----------------------------------------------------------------------

Phase 5 does not imply full YouTube Music parity. Provider capability
and quota constraints remain explicit.

------------------------------------------------------------------------

# PHASE 1 --- Foundation and product shell

**Phase objective:** Establish a clean, secure, maintainable Next.js
application with database persistence, authentication foundations,
design system, configuration validation, and professional repository
hygiene.

**Exit criteria:** - App runs locally from documented instructions. -
Database connects and migrations work on a disposable local database. -
Type checking, linting, tests, and production build pass. - No secrets
or local artifacts are tracked. - Human approves the foundation before
Phase 2.

## P1-T01 --- Repository reconnaissance and engineering baseline

**Tasks** - Inspect the existing repository before changing it. -
Identify package manager, Node version, framework versions, scripts,
branch, and working-tree state. - Do not replace an existing application
or delete files. - Propose the final directory layout and minimal
dependency plan. - Identify any existing secrets or unsafe tracked files
without printing their values.

**Acceptance criteria** - Current project state is summarized. -
Proposed changes are listed before implementation. - Existing work is
preserved. - No code changes are made until the human approves the plan.

**Checks** - `git status --short` - Inspect `package.json`, lockfile,
`.gitignore`, and project structure.

## P1-T02 --- Next.js application and tooling

**Tasks** - Initialize or adapt Next.js App Router with TypeScript. -
Configure Tailwind CSS and the selected UI component foundation. -
Configure ESLint, formatting, and TypeScript strictness. - Add scripts
for dev, build, start, lint, typecheck, and test. - Pin compatible
dependency versions through the lockfile.

**Acceptance criteria** - Application starts locally. - Production build
succeeds. - Lint and typecheck scripts execute. - No unrelated
dependencies are added.

## P1-T03 --- Git hygiene and secret protection

**Tasks** - Review and strengthen `.gitignore`. - Ensure `.env*` files
are ignored except safe `.env.example`. - Ignore build output,
dependencies, local databases, logs, exports, backups, private keys,
certificates, and editor/OS artifacts. - Add a safe `.env.example` with
fake placeholders only. - Add a secret-scanning tool or documented
pre-push secret scan. - Review tracked files and staged changes for
accidental secrets.

**Acceptance criteria** - Real environment files are not tracked. -
`.env.example` contains no real values. - No credentials, private user
data, local exports, or agent transcripts are committed. - Git status is
clean of generated clutter. - No push is performed.

## P1-T04 --- Environment configuration validation

**Tasks** - Create typed server-side environment validation using Zod. -
Define variable names for database, session/auth, encryption, Redis, and
future provider integrations. - Fail fast with variable names only;
never print values. - Keep server-only secrets free of `NEXT_PUBLIC_`
prefixes. - Document local setup.

**Acceptance criteria** - Missing required configuration produces a
safe, readable error. - Secret values never appear in browser bundles or
logs. - `.env.example` is complete for the current phase.

## P1-T05 --- Database and Prisma baseline

**Tasks** - Configure PostgreSQL and Prisma using versions compatible
with the selected project. - Add initial models for User and the
authentication/session mechanism selected. - Add migration workflow and
seed script with synthetic data only. - Add database health check. -
Document local PostgreSQL setup, preferably through Docker Compose.

**Acceptance criteria** - Migration applies to a fresh local database. -
Seed is repeatable and contains synthetic data only. - Database access
is server-side. - No production database is used.

## P1-T06 --- Authentication and dashboard shell

**Tasks** - Implement secure user authentication suitable for the
selected deployment. - Configure secure session cookies and sign-out. -
Add protected dashboard route group. - Build responsive sidebar, header,
navigation, and empty dashboard states. - Add placeholder screens for
Library, Playlists, Connections, Transfer, Sync, and Backups. - Clearly
label unimplemented provider features as unavailable or coming later;
never show fake connected status.

**Acceptance criteria** - User can sign in and sign out. - Protected
pages require a valid session. - Unauthenticated users are redirected
safely. - Dashboard is responsive and keyboard accessible. - Empty
states are honest and useful.

## P1-T07 --- Phase 1 verification and review

**Tasks** - Run lint, typecheck, tests, and production build. - Review
dependencies and security configuration. - Inspect full diff and
tracked-file list. - Update README setup instructions. - Produce a Phase
1 summary.

**Exit checks** - Fresh local setup works from README. - No secrets or
personal data are tracked. - No fake integrations. - All checks pass or
exceptions are explicitly approved. - Human signs off before Phase 2.

------------------------------------------------------------------------

# PHASE 2 --- Canonical library and provider foundations

**Phase objective:** Build SONORA's provider-independent domain model,
persistence, provider capability system, adapter contracts, and durable
job infrastructure. No live provider writes yet.

**Exit criteria:** - Canonical tracks, provider mappings, library
memberships, playlists, ordered playlist items, snapshots, and sync jobs
are represented. - Provider adapters are isolated behind interfaces. -
Domain logic is tested with synthetic fixtures. - Duplicate and
ownership protections are enforced.

## P2-T01 --- Domain model and data ownership decisions

**Tasks** - Define canonical entities and relationships. - Distinguish
canonical tracks from provider-specific track records. - Distinguish
universal liked/saved state from per-provider library membership. -
Preserve playlist item occurrences and order, including repeated
tracks. - Define removal/tombstone semantics and source provenance. -
Document canonical-library ownership and conflict policies.

**Acceptance criteria** - Domain diagram and data dictionary are
reviewed. - Provider IDs are never canonical primary keys. -
Per-provider state is not conflated with universal state.

## P2-T02 --- Prisma schema and migrations

**Tasks** Implement and migrate models for: - User and Library -
ProviderAccount and encrypted credential references - Track and
ProviderTrack - LibraryTrack and ProviderLibraryItem - Playlist and
PlaylistItem - ProviderPlaylist - TrackMatch - LibrarySnapshot and
LibrarySnapshotItem - SyncJob and SyncOperation - SyncRule -
OutboxEvent - IdempotencyRecord or equivalent

**Acceptance criteria** - Foreign keys, unique constraints, and indexes
match documented invariants. - Provider account + external ID is
unique. - Playlist ordering is preserved. - Repeated playlist
occurrences are representable. - User ownership is enforced in service
queries. - Migrations work on a fresh disposable database.

## P2-T03 --- Repository and domain services

**Tasks** - Add typed repositories and services for tracks, provider
mappings, libraries, playlists, and provider accounts. - Add
transactional operations for imports and playlist edits. - Add
pagination and bounded query behavior. - Add soft deletion/tombstones
where required. - Add ownership checks to every user-scoped operation.

**Acceptance criteria** - Domain services do not depend on provider
SDKs. - Cross-user access tests fail safely. - Duplicate imports are
idempotent. - Database operations are transactionally consistent.

## P2-T04 --- Provider adapter contracts and capability registry

**Tasks** - Define normalized types for tracks, playlists, library
items, pagination, errors, and write results. - Define provider adapter
interfaces. - Define explicit capability flags for reading/writing
playlists, tracks, liked items, saved albums, and other supported
collections. - Define typed unsupported-operation errors. - Add fake
adapters for unit and integration tests. - Document capability
verification requirements.

**Acceptance criteria** - Business logic calls shared interfaces only. -
Provider capability differences are explicit. - Fake adapters support
deterministic tests. - Unsupported features cannot silently return
success.

## P2-T05 --- Job queue and outbox foundation

**Tasks** - Configure Redis and BullMQ or an approved equivalent. -
Implement durable outbox event creation and dispatch. - Add worker
process separate from web request lifecycle. - Add job status
transitions and per-item outcomes. - Add bounded retries, exponential
backoff, jitter, and dead-letter handling. - Add graceful worker
shutdown.

**Acceptance criteria** - A committed outbox event can be dispatched
after restart. - Duplicate job delivery does not duplicate domain
effects. - Worker failure is visible and recoverable. - No unbounded
retry loops.

## P2-T06 --- Library and playlist UI

**Tasks** - Implement Library, Tracks, Liked Songs, Playlists, and
Playlist Detail views. - Use server pagination. - Add empty, loading,
error, and populated states. - Use synthetic development fixtures
only. - Show provider provenance where relevant.

**Acceptance criteria** - UI reads from persisted canonical records. -
Playlist order is correct. - No hard-coded fake production counts or
connected badges. - Responsive and keyboard-accessible behavior works.

## P2-T07 --- Phase 2 verification and review

**Tasks** - Test schema constraints, import idempotency, repeated
playlist occurrences, ownership isolation, outbox recovery, and worker
retries. - Run lint, typecheck, unit/integration tests, and build. -
Review migration safety and data privacy. - Update architecture
documentation.

**Exit checks** - Canonical model approved. - Adapter contracts
approved. - No live provider secrets required for test suite. - Human
signs off before Phase 3.

------------------------------------------------------------------------

# PHASE 3 --- Spotify and Apple Music integration and import

**Phase objective:** Connect the first two providers using official
APIs, import supported user libraries, normalize data, and persist
provider snapshots. Begin with read-only imports before enabling writes.

**Exit criteria:** - Spotify and Apple Music development connections
work within their current access rules. - Tokens are handled securely. -
Imports are paginated, repeatable, and resumable. - Provider-specific
capability limitations are shown honestly.

## P3-T01 --- Spotify developer setup and API feasibility

**Human prerequisites** - Create or use a Spotify account. - The
developer/app owner needs an active Spotify Premium subscription for
Development Mode under current rules. - Create a Spotify developer
app. - Add the local callback URL and approved redirect URI. - Add only
the app owner's test account initially. - Review current allowed
endpoints, scopes, quotas, and Development Mode restrictions.

**Agent tasks** - Document current official endpoint availability. -
Confirm whether required playlist and library read endpoints are
available to this app. - Create a provider capability matrix with
evidence and documentation links. - Identify unsupported endpoints
before coding. - Do not request extended quota or assume approval.

**Acceptance criteria** - Feasibility matrix is reviewed by the human. -
No code depends on unverified endpoints. - App credentials are
configured locally, not committed.

## P3-T02 --- Spotify OAuth and token lifecycle

**Tasks** - Implement Authorization Code with PKCE as supported by the
current Spotify flow. - Validate state and redirect URI. - Request
minimum required scopes. - Exchange authorization code server-side. -
Encrypt tokens at rest. - Refresh tokens safely where supported. -
Handle revoked access, missing scopes, and expiry. - Add disconnect and
token deletion.

**Acceptance criteria** - User can connect and disconnect their own
Spotify account. - Tokens are never returned to client components. -
Logs redact credentials. - Invalid state and callback replay are
rejected. - No real tokens appear in tests or commits.

## P3-T03 --- Spotify read-only importer

**Tasks** - Implement supported current endpoints for current user's
accessible playlists and playlist items. - Import supported liked/saved
library items only where current endpoint access permits. - Handle
pagination and provider rate limits. - Normalize provider metadata. -
Persist ProviderTrack mappings and ProviderLibraryItem state. - Persist
import progress and checkpoints. - Preserve playlist order and repeated
occurrences.

**Acceptance criteria** - Import works for the authorized development
account. - Re-running import does not duplicate canonical records. -
Partial import can resume. - Unsupported endpoint access is reported as
a blocker, not worked around.

## P3-T04 --- Apple Music developer setup and token service

**Human prerequisites** - Have an Apple Account. - Enroll in the Apple
Developer Program if required for the intended developer-token
workflow. - Create a MusicKit identifier and private key in the Apple
Developer account. - Register the required web configuration/domain as
applicable. - Store the `.p8` private key only in a secure local secret
location or secret manager. - Never upload the private key to GitHub or
paste it into chat.

**Agent tasks** - Implement server-side Apple developer-token
generation/signing using approved libraries. - Keep the private key
server-only. - Configure MusicKit JS on the web. - Document required
domain and token configuration.

**Acceptance criteria** - Developer token is generated server-side. -
Private key is never sent to browser. - MusicKit authorization flow is
documented and testable. - Token expiry and signing failures are
handled.

## P3-T05 --- Apple Music user authorization and importer

**Tasks** - Initialize MusicKit JS. - Request user authorization only
when needed. - Use Music User Token for user-specific library requests
as documented. - Import supported library songs, playlists, and other
supported collections. - Handle pagination, storefront/catalog
differences, and authorization errors. - Normalize and persist provider
mappings and source membership. - Implement disconnect and local
credential cleanup.

**Acceptance criteria** - User can authorize and revoke access. - Import
works for the authorized test library. - Provider user data remains
private to that user. - Imports are repeatable and resumable. - No
unsupported library collection is represented as imported.

## P3-T06 --- Provider import orchestration and UI

**Tasks** - Add Connections UI with real connection status. - Add import
controls and confirmation. - Run imports through background workers. -
Show progress, imported counts, skipped items, and errors. - Add
per-provider last-imported timestamps. - Add retry for failed
pages/items.

**Acceptance criteria** - Import status survives page refresh and worker
restart. - UI distinguishes imported, skipped, unsupported, and failed
items. - User can retry safe failures. - No fake progress or success.

## P3-T07 --- Phase 3 verification and review

**Tasks** - Test OAuth state validation, scope errors, token
refresh/expiry, pagination, duplicate imports, rate limits, partial
failure, disconnect, and user isolation. - Run unit, integration, lint,
typecheck, and build. - Review official provider docs and scopes used. -
Human tests real integrations with their own accounts.

**Exit checks** - Both integrations are verified within actual access
permissions. - Import data is correct on sample accounts. - Tokens and
private keys are protected. - Human signs off before Phase 4.

------------------------------------------------------------------------

# PHASE 4 --- Track matching, playlists and migration

**Phase objective:** Match equivalent recordings across providers and
build reliable playlist migration from SONORA's canonical library to
supported destinations.

**Exit criteria:** - Track matching uses deterministic evidence and
review workflows. - Playlist transfer preserves order and repeated
occurrences. - Transfers are resumable and idempotent. -
Missing/ambiguous matches are visible. - Provider writes are enabled
only after human review of permissions and API support.

## P4-T01 --- Metadata normalization

**Tasks** - Normalize Unicode, whitespace, punctuation, featuring
credits, artist separators, and common metadata variations. - Preserve
original provider metadata. - Normalize duration units and
explicit/version labels. - Do not destroy meaningful version
information. - Add comprehensive synthetic test fixtures.

**Acceptance criteria** - Normalization is deterministic. - Original
metadata remains available. - Tests cover punctuation, multilingual
names, featuring artists, remasters, live versions, and remixes.

## P4-T02 --- Candidate retrieval and deterministic matching

**Tasks** - Match by ISRC where available. - Retrieve candidates using
provider catalog search. - Score title, artist, duration, album, and
version compatibility. - Detect conflicting ISRC or version evidence. -
Store candidate evidence and match method. - Avoid treating score as
calibrated probability.

**Acceptance criteria** - Exact and ambiguous cases are distinguished. -
Different remixes/live versions are not silently merged. - Matching is
deterministic and testable. - Low-confidence matches remain unresolved.

## P4-T03 --- Manual match review UI

**Tasks** - Show source track and candidate tracks. - Display provider,
title, artist, album, duration, version, and evidence. - Allow confirm,
reject, and search-again actions. - Persist user decisions and audit
timestamps. - Prevent accidental mapping replacement without
confirmation.

**Acceptance criteria** - User can resolve ambiguous tracks. - Decisions
survive refresh. - Rejected candidates are not repeatedly auto-selected
without new evidence. - No LLM silently approves identity.

## P4-T04 --- Canonical playlist management

**Tasks** - Implement create, rename, archive, reorder, add, and
remove. - Preserve repeated track occurrences and position. - Track
source provenance. - Add optimistic concurrency or version checks for
concurrent edits. - Add playlist snapshot/hash calculation.

**Acceptance criteria** - Reordering is stable. - Repeated tracks remain
distinct occurrences. - Concurrent edits cannot silently corrupt
ordering. - Archived playlists remain recoverable.

## P4-T05 --- Spotify and Apple Music destination write adapters

**Tasks** - Verify current official playlist create/add endpoints and
required scopes. - Implement only supported operations. - Add
provider-specific batch sizing, throttling, and response validation. -
Store external playlist mappings. - Verify destination state where
possible. - Do not implement provider write behavior based on
assumptions.

**Acceptance criteria** - Writes work on authorized test accounts. -
Provider limits are respected. - Failed writes are recorded per item. -
No duplicate writes on retry. - User consent is required before external
changes.

## P4-T06 --- Migration job orchestration

**Tasks** - Create migration preview with source, destination, playlist
scope, item counts, matched/unmatched/ambiguous counts, and expected
writes. - Require explicit confirmation before starting writes. - Create
durable job and per-item operations. - Process matched items with
bounded concurrency. - Persist checkpoints and outcomes. - Support
cancellation and safe retry. - Report partial success accurately.

**Acceptance criteria** - Job survives worker restart. - Repeated
request with same idempotency key does not create duplicate job. - Retry
only retries eligible failed operations. - Unmatched tracks are not
silently substituted. - Playlist order and repeated occurrences are
preserved.

## P4-T07 --- Liked/saved item migration

**Tasks** - Define separate semantics for universal favourites and
provider-specific saved/liked state. - Preview supported target
operations and required scopes. - Implement only officially supported
writes. - Keep provider membership state distinct. - Provide a clear
report for unsupported or untransferable items.

**Acceptance criteria** - No assumption that all providers define
"liked" identically. - Unsupported operations are clearly shown. - Retry
and deduplication are safe. - User explicitly confirms bulk writes.

## P4-T08 --- Phase 4 end-to-end verification and review

**Tasks** - Test exact matches, ambiguous matches, remasters, remixes,
explicit/clean variants, missing songs, repeated tracks, playlist
reorder, rate limits, expired tokens, partial writes, cancellation,
worker crash, and retries. - Test Spotify-to-Apple and Apple-to-Spotify
where authorized API access permits. - Review every external write
path. - Run full test suite and production build.

**Exit checks** - A real test playlist transfers correctly in both
directions where supported. - No silent substitution or destructive
sync. - User can inspect and retry failures. - Human signs off before
Phase 5.

------------------------------------------------------------------------

# PHASE 5 --- YouTube capability integration, backups, synchronization and launch hardening

**Phase objective:** Add supported YouTube Data API features, durable
portable backups, explicit synchronization policies, reconciliation,
security hardening, and release readiness.

**Exit criteria:** - YouTube features are capability-gated and
accurately described. - User can export and restore canonical
metadata. - Sync policies are safe and conflict-aware. - Security,
reliability, accessibility, and operational checks pass. - No launch
claim exceeds actual provider permissions.

## P5-T01 --- YouTube API project and feasibility review

**Human prerequisites** - Create or use a Google Account. - Create a
Google Cloud project. - Enable YouTube Data API v3. - Configure OAuth
consent screen and test users as required. - Create OAuth client
credentials for the web application. - Register exact local and
production redirect URIs. - Review quota allocation and current API
policies.

**Agent tasks** - Verify current official endpoints for playlist
listing, playlist items, liked videos, playlist creation, and
insertion. - Build a capability matrix separating YouTube video
resources from YouTube Music library features. - Calculate quota
estimates for import/search/write workflows. - Document unavailable
operations and user-facing wording.

**Acceptance criteria** - No claim of full YouTube Music library
parity. - Capability matrix cites current official docs and date
checked. - Quota guardrails are designed before write operations.

## P5-T02 --- YouTube OAuth and supported adapter

**Tasks** - Implement Google OAuth with state validation and
least-privilege scopes. - Store and encrypt tokens server-side. -
Implement only verified supported playlist and video operations. -
Handle pagination, quota exhaustion, rate limits, and token
revocation. - Expose capability flags to the UI. - Do not use unofficial
YouTube Music APIs or scraping.

**Acceptance criteria** - Authorized user can connect and disconnect. -
Supported playlist operations work on test data. - Unsupported
Music-specific library actions are explicitly unavailable. - Quota is
checked before bulk writes.

## P5-T03 --- Library snapshots and portable export

**Tasks** - Implement immutable or versioned library snapshots. -
Include canonical track metadata, provider mappings where safe, playlist
structure/order, and library membership. - Exclude OAuth credentials,
tokens, private keys, and secrets from exports. - Implement JSON export
with a versioned schema. - Add export integrity checks and clear privacy
messaging.

**Acceptance criteria** - User can download a complete metadata
backup. - Export contains no credentials. - Export schema is
versioned. - Large exports are bounded/streamed safely.

## P5-T04 --- Restore and backup verification

**Tasks** - Validate imported backup schema and version. - Preview
additions, conflicts, and unsupported records. - Restore transactionally
where practical. - Preserve original IDs or map them safely. - Make
repeated restore idempotent. - Never overwrite current library silently.

**Acceptance criteria** - Restore preview is accurate. - User confirms
before applying. - Invalid backup is rejected safely. - Repeated restore
does not create duplicates. - Rollback or recovery path is documented.

## P5-T05 --- Sync rules and reconciliation

**Tasks** - Implement sync rules with source, target, scope, cadence,
and policy. - Support SONORA-master, source-master, additive-only, and
manual-review policies. - Build reconciliation snapshots and change
sets. - Detect additions, removals, reorderings, renames, and
conflicts. - Default to additive-only or preview-first behavior. -
Require explicit opt-in for destructive propagation. - Poll only at
documented, provider-compliant intervals; do not promise webhooks or
real-time updates without provider support.

**Acceptance criteria** - Conflicts are visible and explainable. -
Destructive changes require explicit approval. - Provider disconnection
does not affect canonical library. - Reconciliation is resumable and
auditable.

## P5-T06 --- Security, privacy and account controls

**Tasks** - Review token encryption, key management, rotation, and
redaction. - Add user data export and account deletion workflow. - Add
provider disconnect/revoke flow. - Review authorization on every
user-scoped route. - Add rate limiting and abuse controls. - Review
CSRF, XSS, SSRF, open redirects, and IDOR risks. - Ensure secrets do not
enter analytics, logs, error reporting, or browser bundles.

**Acceptance criteria** - Security checklist is completed. - Cross-user
access tests pass. - Tokens and keys are never exposed. - Deletion
behavior is documented and tested on disposable data. - No production
destructive operation is run without explicit approval.

## P5-T07 --- Observability and operations

**Tasks** - Add structured logs with sensitive-field redaction. - Add
error monitoring and worker health checks. - Add queue depth, retry,
failure, and provider quota metrics. - Add alerting for repeated
provider failures and stuck jobs. - Document backup, restore, incident,
and key-rotation procedures.

**Acceptance criteria** - Operators can identify failed/stuck jobs. -
Logs contain correlation IDs but no secrets. - Worker restart and queue
recovery are tested. - Incident runbook exists.

## P5-T08 --- UX, accessibility and performance polish

**Tasks** - Review responsive layouts. - Add accessible focus, labels,
keyboard support, and reduced-motion behavior. - Add clear loading,
empty, unsupported, partial, and error states. - Improve pagination and
large-library performance. - Ensure provider capability and permission
limitations are understandable. - Add final onboarding and setup
guidance.

**Acceptance criteria** - Core flows work on desktop and mobile
browsers. - No false connected/success states. - Keyboard and
screen-reader basics are checked. - Large library views are paginated.

## P5-T09 --- Release candidate and launch review

**Tasks** - Run full unit, integration, contract, and end-to-end
suites. - Run lint, typecheck, production build, dependency audit, and
secret scan. - Review current provider policies and app approval
status. - Verify production environment variables are configured in the
deployment secret manager. - Verify OAuth production callback URLs. -
Verify database backups and migration procedure. - Review
pricing/billing only if separately approved. - Prepare release notes and
known limitations.

**Acceptance criteria** - All critical tests pass. - No secrets or
personal data are tracked. - No unapproved provider capability is
advertised. - Production deployment is explicitly approved by the
human. - Human signs off on release.

------------------------------------------------------------------------

# Human setup checklist --- accounts, keys and actions

Do these yourself in provider dashboards. Do not paste secrets into the
coding agent's chat or commit them.

## A. Required now for Phase 1

-   [ ] GitHub account and a private repository initially, if you want
    remote backup.
-   [ ] Install a supported Node.js LTS release.
-   [ ] Install Git.
-   [ ] Install Docker Desktop or another local PostgreSQL option.
-   [ ] Choose a package manager and keep one lockfile.
-   [ ] Create the local project folder.
-   [ ] Do not create production provider credentials yet.

## B. Spotify --- needed in Phase 3

-   [ ] Spotify account with Premium for the Development Mode app owner.
-   [ ] Spotify for Developers account.
-   [ ] Create a developer app.
-   [ ] Register exact redirect URI,
    e.g. `http://127.0.0.1:3000/api/v1/connections/spotify/callback`
    (use the exact URI your implementation chooses).
-   [ ] Add your own Spotify account to the app's authorized users if
    required.
-   [ ] Obtain Client ID and Client Secret.
-   [ ] Configure them only in ignored local environment variables or a
    secret manager.
-   [ ] Review current API endpoint restrictions and scopes before
    implementation.

**Current constraint:** Development Mode supports up to five authorized
users and requires the app owner to have Premium. Do not assume extended
quota access will be granted.

Official docs: - https://developer.spotify.com/dashboard -
https://developer.spotify.com/documentation/web-api -
https://developer.spotify.com/documentation/web-api/concepts/quota-modes -
https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide

## C. Apple Music --- needed in Phase 3

-   [ ] Apple Account.
-   [ ] Apple Developer Program membership for the developer-token
    workflow.
-   [ ] Create a MusicKit identifier.
-   [ ] Create a MusicKit private key.
-   [ ] Download the `.p8` key once and store it securely.
-   [ ] Record the Key ID and Team ID in your local secret manager.
-   [ ] Configure the web app's domain/origin as required.
-   [ ] Test MusicKit JS authorization with an Apple Music subscriber
    account.

Never commit or upload the `.p8` key.

Official docs: - https://developer.apple.com/musickit/ -
https://developer.apple.com/documentation/applemusicapi -
https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens -
https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit

## D. YouTube / Google --- needed in Phase 5

-   [ ] Google Account.
-   [ ] Google Cloud project.
-   [ ] Enable YouTube Data API v3.
-   [ ] Configure OAuth consent screen.
-   [ ] Add test users if the app is in testing.
-   [ ] Create OAuth client ID for Web application.
-   [ ] Register exact local and production redirect URIs.
-   [ ] Obtain Client ID and Client Secret.
-   [ ] Review quota allocation and request additional quota only if
    justified.
-   [ ] Configure credentials only in local ignored env or secret
    manager.

Official docs: - https://console.cloud.google.com/ -
https://developers.google.com/youtube/v3 -
https://developers.google.com/youtube/v3/getting-started -
https://developers.google.com/youtube/v3/determine_quota_cost

## E. Infrastructure accounts --- later

-   [ ] PostgreSQL hosting account (or continue local Docker during
    development).
-   [ ] Redis hosting account (or local Docker during development).
-   [ ] Vercel account or chosen Next.js host.
-   [ ] Worker hosting provider.
-   [ ] Error monitoring account.
-   [ ] Domain name only when ready for preview/production OAuth
    callbacks.
-   [ ] Secret manager / managed encryption key service before
    production.

Do not pay for all infrastructure on day one. Local Docker is enough for
early phases.

------------------------------------------------------------------------

# Environment variable names

The coding agent should create `.env.example` with placeholders only.
Actual values stay in `.env.local` or a secret manager.

``` dotenv
# Application
APP_URL=http://127.0.0.1:3000
AUTH_SECRET=replace-with-local-random-secret

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/sonora

# Redis
REDIS_URL=redis://localhost:6379

# Encryption key for provider tokens; generate locally and keep secret
TOKEN_ENCRYPTION_KEY=replace-with-32-byte-base64-key

# Spotify
SPOTIFY_CLIENT_ID=placeholder
SPOTIFY_CLIENT_SECRET=placeholder
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/api/v1/connections/spotify/callback

# Apple Music
APPLE_TEAM_ID=placeholder
APPLE_MUSIC_KEY_ID=placeholder
APPLE_MUSIC_PRIVATE_KEY_PATH=/secure/local/path/AuthKey_placeholder.p8

# Google / YouTube
GOOGLE_CLIENT_ID=placeholder
GOOGLE_CLIENT_SECRET=placeholder
GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/api/v1/connections/youtube/callback
```

The variable list may evolve as the implementation chooses the exact
auth and token-signing approach. Do not put private keys or real values
in `.env.example`.

------------------------------------------------------------------------

# GitHub policy and first repository setup

Recommended initial repository: - Name: `sonora` - Visibility: Private
during early development; public only after a deliberate review. -
Default branch: `main` - Use feature branches for tickets if desired. -
Do not push secrets, database dumps, local exports, credentials, private
keys, agent transcripts, or generated scratch files. - Do not add
artificial "vibe-coded" or "generated by AI" files. - Keep real
engineering documentation, setup instructions, architecture, tests, and
commit history professional and truthful.

Before first push: 1. Review `.gitignore`. 2. Run a secret scan. 3. Run
`git status --short`. 4. Inspect the complete staged diff. 5. Confirm no
`.env*` file except `.env.example` is staged. 6. Confirm no private
keys, credentials, user data, or logs are staged. 7. Ask the human for
explicit approval.

------------------------------------------------------------------------

# Current official API references

Re-check these during the relevant ticket; APIs and policies can change.

-   Spotify Web API: https://developer.spotify.com/documentation/web-api
-   Spotify Development Mode quota:
    https://developer.spotify.com/documentation/web-api/concepts/quota-modes
-   Spotify February 2026 migration guide:
    https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
-   Apple Music API:
    https://developer.apple.com/documentation/applemusicapi
-   MusicKit JS: https://developer.apple.com/documentation/musickitjs
-   Apple Music user authentication:
    https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit
-   YouTube Data API: https://developers.google.com/youtube/v3
-   YouTube quota costs:
    https://developers.google.com/youtube/v3/determine_quota_cost
-   Next.js environment variables:
    https://nextjs.org/docs/app/guides/environment-variables

------------------------------------------------------------------------

# Phase approval record

Use this section as a human-maintained record. The coding agent must not
mark a phase approved on the human's behalf.

  Phase     Human approval   Date   Notes
  --------- ---------------- ------ -------
  Phase 1   Pending
  Phase 2   Pending
  Phase 3   Pending
  Phase 4   Pending
  Phase 5   Pending
