# SONORA Engineering Rules

**Document type:** Repository-level instructions for the coding agent\
**Applies to:** Every ticket, phase, pull request, commit, and code
change\
**Product:** SONORA --- a provider-independent music library and
portability platform

## 1. Operating model: one ticket at a time

1.  Read `RULES.md` and `TICKETS.md` before changing anything.
2.  Work on **only the currently assigned ticket**. Do not start the
    next ticket or phase without explicit approval from the human
    reviewer.
3.  Before coding, inspect the existing repository, package manager,
    framework versions, current branch, working tree, and relevant
    files. Do not overwrite or replace an existing project blindly.
4.  State a short implementation plan, files likely to change,
    assumptions, and risks before making changes.
5.  Implement the smallest complete change that satisfies the ticket.
    Avoid unrelated refactors, speculative abstractions, and unnecessary
    dependencies.
6.  Run the ticket's required checks and relevant regression tests.
    Never claim a check passed unless it was actually run and passed.
7.  At completion, stop and provide the review report defined in
    Section 14. Wait for human approval before continuing.
8.  If blocked by missing credentials, API access, unclear requirements,
    destructive changes, or provider-policy uncertainty, stop and ask.
    Do not fabricate credentials, API behavior, test results, or
    provider capabilities.

## 2. Product invariants

-   SONORA's canonical library is independent of any streaming provider.
-   Provider IDs are external mappings, never canonical primary keys.
-   SONORA stores music metadata and user library relationships; it does
    not host, proxy, download, or redistribute provider audio.
-   Never imply that YouTube Data API provides complete YouTube Music
    library parity. Implement only verified, officially supported
    capabilities.
-   Provider capabilities must be explicit and discoverable at runtime.
    Unsupported operations must be disabled or reported clearly, never
    silently simulated.
-   Imports must be repeatable. Re-importing the same source must not
    create duplicate canonical entities or duplicate provider mappings.
-   Playlist occurrence and order are meaningful. Do not globally
    deduplicate repeated occurrences inside a playlist unless the
    product requirement explicitly says so.
-   Preserve source provenance and per-provider state separately from
    the universal library state.
-   Never propagate destructive changes by default. Use additive or
    preview-first behavior unless a user explicitly enables a
    destructive policy.
-   Every provider write must be idempotent where possible, auditable,
    rate-limited, and recoverable.
-   A provider disconnect must not delete the user's canonical library
    or backups.

## 3. Architecture and code quality

-   Use the stack already selected by the project: Next.js App Router,
    TypeScript, Tailwind CSS, PostgreSQL, Prisma, Zod, and a separate
    background worker where needed. Do not change the stack without
    approval.
-   Prefer a modular monolith with clear module boundaries over
    premature microservices.
-   Keep provider-specific code inside provider adapters. Business logic
    must depend on shared interfaces, not directly on provider SDKs or
    HTTP response shapes.
-   Keep UI components, domain logic, persistence, provider clients, and
    background jobs separated.
-   Use strict TypeScript. Avoid `any`; if unavoidable, isolate it,
    explain it, and validate at runtime.
-   Validate all external input and provider responses at system
    boundaries with schemas.
-   Use typed domain errors. Do not swallow exceptions or return fake
    success.
-   Use transactions for multi-record state changes. Use an outbox or
    another durable mechanism when database writes must trigger
    asynchronous jobs.
-   Use pagination for potentially large collections. Avoid loading an
    entire library into memory without a documented limit.
-   Add database indexes and uniqueness constraints for real query and
    idempotency requirements.
-   Avoid N+1 queries and unbounded API calls.
-   Use UTC timestamps in storage and explicit timezone handling in UI.
-   Keep functions small, names meaningful, and comments focused on
    non-obvious reasoning.
-   Do not introduce a dependency for functionality that can be handled
    safely by the existing stack.
-   Do not use an LLM to decide recording identity or silently resolve
    ambiguous song matches. Use deterministic evidence and user
    confirmation.

## 4. Provider API compliance

-   Use official provider APIs and documented authentication flows only.
-   Before implementing or changing an endpoint, verify its current
    official documentation, availability, required scopes, quota cost,
    restrictions, and response shape.
-   Record the documentation URL and the date checked in the relevant
    ticket or implementation note.
-   Do not rely on undocumented endpoints, reverse-engineered private
    APIs, scraping, browser automation against provider sites, or
    credential sharing.
-   Do not circumvent provider rate limits, quota restrictions, user
    allowlists, app review, or platform policies.
-   Handle `401`, `403`, `404`, `429`, transient `5xx`, pagination,
    token expiry, and partial results distinctly.
-   Respect `Retry-After` when supplied. Use bounded exponential backoff
    with jitter for retryable failures.
-   Request minimum OAuth scopes. Explain why each scope is needed and
    request additional permissions only when the user invokes the
    feature requiring them.
-   Validate OAuth `state`, use PKCE where supported, validate redirect
    URIs, and protect callback routes from CSRF and replay.
-   Do not assume a feature is supported merely because a similarly
    named endpoint exists on another provider.
-   Keep provider capability flags separate for read, write, library,
    playlist, liked-item, album, and synchronization operations.
-   Never claim that an operation succeeded until the provider response
    and, where practical, subsequent verification support that claim.

## 5. Security and privacy --- mandatory

### Secrets

-   Never hard-code, print, log, screenshot, commit, or place
    credentials in source code, tests, fixtures, issue descriptions,
    agent prompts, documentation, or screenshots.
-   Never ask the human to paste secrets into chat. Ask them to
    configure secrets locally or in the deployment provider's secret
    manager.
-   Keep real credentials only in ignored local environment files or a
    managed secret store.
-   `.env.example` may contain variable names and clearly fake
    placeholders only. It must never contain real keys, tokens,
    passwords, private keys, database URLs, or user data.
-   Only server-side environment variables may contain secrets. Never
    prefix a secret with `NEXT_PUBLIC_`.
-   Encrypt provider access and refresh tokens at rest using
    authenticated encryption and a key stored outside the database. Plan
    key rotation.
-   Do not expose OAuth tokens to client components, browser storage,
    URLs, analytics, or error reporting.
-   Redact authorization headers, cookies, tokens, client secrets,
    private keys, and personal data from logs.
-   Do not commit `.env`, `.env.*.local`, credential JSON, Apple `.p8`
    keys, certificates, keystores, database dumps, or local backups.

### Personal data

-   Collect the minimum profile data needed.
-   Do not store provider passwords.
-   Do not store audio files.
-   Do not include real user playlists, account identifiers, emails,
    tokens, or private library exports in test fixtures.
-   Provide or preserve data export, provider disconnect, and account
    deletion paths as the product matures.
-   Enforce user ownership on every library, playlist, connection,
    snapshot, and sync-job query. Never trust a user ID supplied by the
    browser when session identity is available.
-   Avoid leaking whether another user's account, playlist, or resource
    exists.

### Web security

-   Use secure, HTTP-only, SameSite cookies for sessions.
-   Apply CSRF protections to state-changing routes where relevant.
-   Validate and constrain redirect destinations to prevent open
    redirects.
-   Apply rate limits to authentication, OAuth initiation/callbacks,
    imports, exports, and expensive matching endpoints.
-   Prevent SSRF: do not fetch arbitrary user-supplied URLs. Restrict
    provider requests to known official hosts.
-   Escape user-controlled text in UI and avoid unsafe HTML rendering.
-   Use least-privilege database credentials and separate development
    and production environments.

## 6. Git and GitHub hygiene

The public repository must look like a professional software project. Do
not add artificial AI/vibe-coding labels, agent transcripts, prompt
dumps, temporary planning artifacts, or tool-generated clutter. Do not
falsify authorship, provenance, tests, or product capabilities.

### Never commit

-   `.env` or any real environment file.
-   OAuth client secrets, access/refresh tokens, API keys, private keys,
    certificates, signing keys, passwords, session secrets, or
    production connection strings.
-   Real user data, account exports, database dumps, logs containing
    personal data, or screenshots showing credentials.
-   `node_modules/`, `.next/`, build output, coverage output, caches,
    editor workspace state, OS metadata, temporary files, or local
    database files.
-   Agent conversation transcripts, hidden chain-of-thought, prompt
    histories, local tool state, scratch files, or unrequested generated
    documentation.
-   Files or claims that falsely state tests, security reviews, provider
    approvals, or API capabilities have been completed.

### Expected repository hygiene

-   Maintain a deliberate `.gitignore` and review it before the first
    commit.
-   Commit `.env.example` only with fake placeholders and explanatory
    comments.
-   Include legitimate project docs such as `README.md`, `RULES.md`,
    `TICKETS.md`, architecture notes, setup instructions, and license
    only when appropriate.
-   Use descriptive commits such as
    `feat(library): add canonical track persistence`.
-   Keep commits focused and reviewable. Do not squash, amend,
    force-push, or rewrite shared history without approval.
-   Before every commit, inspect `git status`, `git diff --check`, and
    the full staged diff.
-   Before pushing, inspect the exact commit range and ensure no secrets
    or personal data are included.
-   If a secret is ever committed, treat it as compromised: stop, notify
    the human, rotate/revoke it, and follow a history-cleanup plan.
    Deleting the file in a later commit is not sufficient.
-   Never push to GitHub or create a remote repository unless the human
    explicitly approves that action.

### Suggested `.gitignore` additions

``` gitignore
# Dependencies and build output
node_modules/
.next/
out/
dist/
build/
coverage/
.turbo/
.cache/

# Environment and secrets
.env
.env.*
!.env.example
!.env.template
*.pem
*.key
*.p8
*.p12
*.pfx
*service-account*.json
*credentials*.json
secrets/
private/

# Local databases, exports, and logs
*.db
*.sqlite
*.sqlite3
*.dump
*.sql.gz
*.log
logs/
exports/
backups/
data/

# Local/editor/OS state
.DS_Store
Thumbs.db
.vscode/*
!.vscode/extensions.json
.idea/
*.swp
*.swo
```

Review ignore patterns carefully. Do not ignore legitimate migrations,
fixtures containing synthetic data, or project source.

## 7. Environment variable policy

-   Maintain `.env.example` with variable names, safe fake placeholders,
    and short descriptions.
-   Validate required environment variables at startup with a schema.
    Fail fast with a helpful message that names the missing variable but
    never prints its value.
-   Keep secrets server-only. Public client configuration must be
    explicitly reviewed.
-   Use separate credentials for local development, preview, and
    production.
-   Never use production provider credentials or production user data in
    automated tests.
-   Document where each credential is created and which callback URL
    must be registered, without documenting its value.

## 8. Database and migration rules

-   Prisma schema changes must include migrations.
-   Never reset, drop, truncate, or destructively alter a database
    without explicit approval and a verified backup.
-   Prefer additive migrations and staged backfills.
-   Add uniqueness constraints for provider account + external ID,
    canonical mappings, and idempotency keys where applicable.
-   Use soft deletion or tombstones when needed to distinguish removed
    items from never-imported items.
-   Preserve playlist item ordering and repeated occurrences.
-   Test migrations against a disposable local database.
-   Never run migrations against production without explicit approval.

## 9. Testing requirements

For each ticket: - Add or update unit tests for domain logic. - Add
integration tests for database and adapter boundaries where
applicable. - Add provider contract tests using mocked official API
responses; do not require live credentials in CI. - Add regression tests
for bugs. - Run formatting, lint, type checking, and relevant tests. -
Run a production build at phase gates where practical. - Report commands
and actual results. Clearly label skipped checks and why they were
skipped. - Test error paths: invalid input, missing scopes, expired
tokens, rate limits, pagination, partial failures, duplicate requests,
and worker retries where relevant.

Never write tests that merely assert that a mock returns the value
configured in the same test while claiming the real provider integration
is verified.

## 10. UI and accessibility

-   Use the established design system and existing components before
    adding new ones.
-   Build responsive layouts and accessible keyboard interactions.
-   Provide loading, empty, success, partial-success, unsupported, and
    error states.
-   Do not show fake provider connection status or fabricated library
    counts.
-   Use realistic but clearly synthetic demo data only in demo mode.
-   Avoid excessive animation and ensure reduced-motion preferences are
    respected.
-   Clearly distinguish provider-sourced metadata from user-edited
    canonical metadata.

## 11. Sync and migration safety

-   Every sync job must have durable state, progress, timestamps, and
    per-item outcomes.
-   Use idempotency keys for job creation and provider writes where
    possible.
-   Persist an operation before performing an external side effect, then
    record the result.
-   Make retry behavior bounded and safe.
-   Do not retry permanent errors such as invalid scopes or unsupported
    operations indefinitely.
-   Use provider-specific rate limiting and concurrency limits.
-   Preview removals and destructive changes. Default to additive
    behavior.
-   Handle ambiguous track matches as unresolved, not as silent guesses.
-   Verify destination state where provider capabilities permit.
-   Do not promise real-time synchronization when the provider offers no
    reliable change feed or webhook. Use clearly disclosed polling
    intervals.

## 12. Documentation standards

-   Keep README setup instructions accurate and executable.
-   Document required external accounts, OAuth callback URLs,
    environment variable names, scopes, and known API limitations.
-   Do not put real credentials or screenshots containing personal data
    in documentation.
-   Update docs when a ticket changes setup, architecture, endpoints, or
    provider behavior.
-   Do not create unrequested files such as `AI_README`,
    `VIBE_CODING.md`, agent transcripts, or prompt logs.

## 13. Definition of done

A ticket is done only when: - Its acceptance criteria are met. - Code is
typed, validated, and appropriately tested. - No secrets or personal
data are exposed. - No unrelated changes are included. - Relevant
documentation is updated. - The working tree and diff have been
inspected. - The human reviewer has received the completion report and
approved the ticket.

A phase is done only when every ticket in that phase is approved and its
phase exit criteria pass.

## 14. Required report after every ticket

Stop and provide this exact structure:

``` text
TICKET: [ID and title]
STATUS: Complete / Blocked / Partial

1. What changed
- Files added/modified
- Behavior implemented

2. Acceptance criteria
- [criterion]: Pass/Fail/Not tested

3. Verification
- Commands run
- Actual results
- Tests added

4. Security and provider compliance
- Secrets check
- Scopes/endpoints/limitations considered
- Any remaining risks

5. Git status
- Branch
- Working-tree status
- Files staged (if any)
- Commit created? (Only if explicitly approved)

6. Known limitations
- Remaining issues and follow-up dependencies

7. Reviewer decision requested
- Exact decision or information needed
```

Do not proceed to the next ticket until the human explicitly approves.
