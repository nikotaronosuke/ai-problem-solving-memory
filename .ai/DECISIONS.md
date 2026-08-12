# DECISIONS

Updated: 2026-08-11

This file records implementation-facing decisions that are safe to keep in the public repository. Detailed product rationale remains in the private specification repository.

## D-001 — Public implementation / private detailed specification

The public repository `nikotaronosuke/ai-problem-solving-memory` contains implementation code, public documentation and implementation state.

Detailed upstream specification and task breakdown remain in the private repository `nikotaronosuke/ai-problem-solving-memory-spec`.

## D-002 — Source of truth

`docs/spec/final-mvp-spec.md` in the private repository is the highest-priority MVP specification. Phase documents remain design history and rationale.

## D-003 — Implementation phases

Implementation is divided into Phases 1–9. Each Phase has a Definition of Done and is completed/reviewed before dependent later phases begin.

## D-004 — Core MVP milestone

Implementation Phase 7 is the Core MVP validation gate. UI and conversational AI adapters do not substitute for the required cross-project reuse E2E.

## D-005 — Initial technical direction

The MVP is planned around TypeScript / Node.js with PostgreSQL. Supabase is the first-choice MVP PostgreSQL environment while domain logic should avoid unnecessary Supabase-specific coupling.

## D-006 — AI integration boundary

Memory Server/API is the source of truth. AI-specific behavior belongs behind adapters. No single AI vendor or protocol owns the Memory model.

## D-007 — Git operating rule

AI agents must not push unless explicitly requested by the user. Destructive git operations require explicit approval.

## D-008 — Development toolchain (P1-01)

The implementation toolchain is fixed as: npm as package manager with a committed lockfile, TypeScript in strict mode, ESM with `NodeNext` module resolution, ESLint 9 flat config with type-aware rules, Prettier for formatting, and Vitest as the test runner.

Verification commands are `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test`, aggregated as `npm run check`.

Prettier does not format `README.md`, `CLAUDE.md` or `.ai/`. Those are hand-maintained prose edited by humans and AI sessions, and automated reformatting would create noise without benefit.

`.gitattributes` fixes the working tree to LF so formatting checks behave identically on every platform.

## D-009 — Database access and migrations (P1-03)

Migrations are owned by the Supabase CLI and live in `supabase/migrations/` as plain SQL applied in filename order. `npm run db:reset` rebuilds a local database from them, which is how a migration is verified against a clean database.

The Supabase CLI is a devDependency, not a global install, so the migration tool is pinned per repository.

Application access to PostgreSQL uses `pg` (node-postgres) with a connection pool. Supabase is the local environment providing PostgreSQL; it is not an application dependency. The service does not use PostgREST, Supabase Auth, Storage, Realtime or Edge Functions, and those are disabled in `supabase/config.toml`. This keeps D-005's PostgreSQL-centric boundary real rather than aspirational.

`src/db/` is the database boundary, split so that configuration resolution, pool lifecycle and health probing are separately testable. Importing any module in it opens no connection; a pool exists only when a caller asks for one, and the caller closes it.

## D-010 — Database credential handling (P1-03)

`DATABASE_URL` is read only from the environment, and only where a connection is actually opened. Code that does not touch the database — including most tests — runs without it.

A connection string is treated as a credential. It must not appear in an error message, a log line, a test fixture, `.ai/`, `docs/` or Memory content. Errors report the host, which carries no credential, and the reason.

While `NODE_ENV=test`, connecting to a non-local database host is refused. Test runs cannot reach a real deployment even if the environment is pointed at one.

## D-011 — Local stack exposure (P1-03)

Docker publishes the local Supabase ports on all interfaces rather than loopback only. The repository reduces the exposure it controls by enabling only the services this project uses, leaving three published ports.

The remaining binding behavior is a machine-wide Docker daemon setting, so it is deliberately not changed by this repository. This is accepted rather than treated as a blocker: the local stack holds no real Memory data, and the operating rule is to stop it when not in use. Revisit if the stack ever needs to run on an untrusted network.

## D-012 — Closed value sets use text-backed DOMAINs, not native enums (P1-04)

A value set with a fixed list of allowed values is represented in PostgreSQL as a DOMAIN over `text` with a named CHECK constraint, not as a native `ENUM` type.

Reasons: a DOMAIN can be defined before any table exists, so database-level constraints are in place ahead of the schema; changing the allowed set is an ordinary migration rather than enum type surgery; and columns reuse the DOMAIN by name from P1-06 onward.

Nullability is not part of a DOMAIN. Whether a value may be absent belongs to the column that uses it.

On the application side each set is declared once, as a readonly tuple in `src/domain/enums.ts`, with its type derived from that tuple. No value is written twice in TypeScript. `src/db/enum-domains.ts` is the single place pairing a set with its DOMAIN, and lives in the database boundary so the domain layer holds no persistence names.

The two sides are kept in step by behavior against a real database, not by parsing migration text: every application value is cast through its DOMAIN, and the constraint is read back from PostgreSQL's catalog and compared with the application set. A change to one side without the other fails the test suite.

## D-013 — Owner identity is issued and owned by the Memory Server (P1-05)

`owner_id` is a UUID the Memory Server manages, stored as PostgreSQL `uuid`. It is never an AI vendor account id, a GitHub user id, or a value derived from any external provider identity, and the Memory model does not map to provider accounts.

This follows directly from the product invariant that Memory is user-owned and not tied to one AI vendor. Ownership has to survive changing the AI, the account behind it, or the protocol in front of it. Owner identity is therefore not delegated to Supabase Auth, which stays disabled in this repository.

The column carries no database-side default. The application always supplies the id, so ownership is an explicit decision rather than something the database invents on insert.

`OwnerId` is a branded type in TypeScript: an arbitrary string cannot be used as an owner, and a value becomes an `OwnerId` only by passing UUID validation. Values are normalised to lowercase, matching what PostgreSQL returns, so the same owner cannot compare unequal depending on which side it came from.

## D-014 — Owner context is required before owner-scoped work (P1-05)

Owner-scoped operations take an `OwnerContext` rather than a bare id. A context is produced only by resolution, which fails closed on three distinguishable conditions: the owner is not configured, the configured value is not a usable id, or it names an owner with no row. A well-formed UUID is not sufficient — the owner must exist.

Resolution runs when owner-aware work begins, not at import time, so code that never touches owned data keeps working without an owner configured.

The read path takes the context and returns only that owner. No application API accepts an arbitrary owner id and returns its record, so crossing the ownership boundary is not something a caller can express. The bootstrap path that creates a local owner is kept separate and only ever inserts.

A rejected owner value is never echoed in an error. A misconfigured variable can hold something that was never meant to be printed, so only the reason is reported. An id that has already been validated as a UUID is safe to name, and is, because that is what makes an unknown owner debuggable.

## D-015 — Authentication is staged across phases (P1-05)

P1-05 covers owner identity, local owner context and the owner boundary, and nothing more. In local development the owner comes from `MEMORY_OWNER_ID`.

Deliberately deferred: HTTP request auth context is P2-01. Client credentials, their lifecycle and revocation, and the separation of owner identity from client identity are P3-04.

No token table, bearer token, OAuth flow, JWT, password, session, credential hash or provider account mapping exists in this phase, and none should be added ahead of the phase that owns it.
