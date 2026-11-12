# Security Policy

## Supported Versions & Current Status

SONORA is currently in active pre-release development (Phase 2). **Production user authentication and live OAuth provider adapters are not yet implemented.** Do not deploy the current codebase in a public multi-user production environment until production authentication is introduced.

## Core Security Controls

- **Server-Only Secrets:** All cryptographic keys, database credentials, and provider client secrets are validated server-side via Zod in `src/config/env.ts` and rejected if prefixed with `NEXT_PUBLIC_`. Production mode strictly requires a 256-bit (64-hex-character) `TOKEN_ENCRYPTION_KEY`.
- **Authenticated Token Storage:** Provider access/refresh tokens are encrypted at rest with AES-256-GCM AEAD (`src/lib/encryption.ts`), using 96-bit random IVs and 128-bit authentication tags, and support key rotation via `reencryptToken`. Decrypted or ciphertext tokens are stripped from client-facing provider account DTOs.
- **Session & CSRF Protection:** Sessions are validated against signed JWTs paired with SHA-256 hashed server-side records in PostgreSQL. State-changing authentication endpoints reject `GET` requests, validate `Origin`/`Host` headers (`src/lib/csrf.ts`), and issue `HttpOnly`, `SameSite=Lax` cookies (`Secure` in production). Note that while `HttpOnly` prevents direct script reads of cookies via `document.cookie`, output encoding and avoidance of unsafe HTML injection protect against same-origin XSS request invocation.
- **Demo Mode Containment:** Synthetic demo sign-in fails closed unless both `NODE_ENV=development` and `DEMO_AUTH_ENABLED=true` are set. Passwordless email-only login is disabled unconditionally.
- **Multi-Tenant Database Isolation:** Ownership is enforced both in service guards and via PostgreSQL composite foreign keys (`(id, userId)` across libraries, playlists, snapshots, and provider account links).

## Reporting a Vulnerability

If you discover a security issue, please report it privately via GitHub Security Advisories at:

- `https://github.com/ruzzhdontmiss/sonora/security/advisories/new`

Please do **not** open a public issue containing exploit details or real credentials.
