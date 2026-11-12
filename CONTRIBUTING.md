# Contributing to SONORA

Thank you for your interest in contributing to SONORA!

## Development Workflow

1. **Architecture:** Keep changes cleanly inside the modular monolith boundaries under `src/modules/` and preserve strict database ownership and test coverage.
2. **Package Manager & Runtime:** Use **Node.js 26 Active LTS** and **`pnpm`**. Do not commit alternative lockfiles (`package-lock.json` or `yarn.lock`).
3. **Database Migrations:** Always generate additive, reversible Prisma migrations (`pnpm db:migrate`). Never edit historical applied migrations destructively.
4. **Honesty & Capability Boundaries:** Never mock or fake live streaming provider responses in runtime production paths. External capabilities must remain explicit via provider capability interfaces.

## Required Checks Before Submitting Changes

Ensure local Docker services (`postgres` and `redis`) are running (`docker compose up -d`), then run every check:

```bash
pnpm typecheck     # Must pass with 0 TypeScript errors
pnpm lint          # Must pass with 0 ESLint errors/warnings
pnpm test          # All unit and integration tests must pass
pnpm build         # Production build must succeed
pnpm secret-scan   # Must report zero secret/environment violations
```

## Security Hygiene

- Never commit `.env`, `.env.local`, OAuth client secrets, Apple `.p8` keys, certificates, or real user data.
- Never add `NEXT_PUBLIC_` prefixes to sensitive keys, tokens, or secrets.
- Always include regression tests when fixing concurrency, tenancy, security, or matching defects.
