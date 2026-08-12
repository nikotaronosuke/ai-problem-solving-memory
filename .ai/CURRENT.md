# CURRENT

Updated: 2026-08-12

## Current phase

Implementation Phase 1 — Foundation / Repository / Database: **COMPLETE**

Implementation Phase 2 — Core Memory API: **READY, NOT STARTED**

## Source of truth

Private specification repository `nikotaronosuke/ai-problem-solving-memory-spec`:
- `docs/spec/final-mvp-spec.md`
- `docs/spec/mvp-os-boundary-addendum.md`
- `docs/implementation/mvp-roadmap.md`
- `docs/implementation/phase2-task-breakdown.md`

## What exists now

Read this to know what you are building on.

**Runtime.** TypeScript in strict mode, ESM with `NodeNext`, npm with a committed lockfile. `npm run check` runs typecheck, lint, format check and tests; `npm run build` compiles to `dist/`. See `docs/development.md` for commands.

**Database.** PostgreSQL, with Supabase CLI + Docker as the local environment. Nine migrations under `supabase/migrations/`, replayable onto a clean database with `npm run db:reset`. Six public tables: `owners`, `projects`, `environments`, `problems`, `events`, `verifications`.

**Value sets.** Six closed sets — ProblemStatus, FixKind, EventType, VerificationType, Confidence, Freshness — declared once in `src/domain/enums.ts` and enforced by text-backed PostgreSQL DOMAINs with CHECK constraints. No native enum types. A test drives every application value through the database and compares the constraint back, so the two cannot drift.

**Ownership.** `owner_id` is a UUID the Memory Server issues, never a vendor account id. Every table carries it, so owner scope needs no join. An `OwnerContext` comes only from `resolveOwnerContext`, which fails closed when the owner is missing, malformed or absent from the database.

**Relations.** Each level is checked against its parent as a composite key, so an Environment cannot belong to another owner's Project, a Problem cannot reference another Project's Environment, and an Event cannot attach to another owner's Problem. Reading someone else's record is indistinguishable from reading one that does not exist.

**Events and Verifications.** Both are append-only: no update path, no `updated_at`, no trigger. A Verification attaches to the Problem directly, never to an Event, and carries a boolean `result` so a successful verification can be found mechanically. `client_event_id` is required and unique per `(owner_id, client_event_id)` within each table, so a retried write cannot land twice.

**Deletes.** Every foreign key is `ON DELETE RESTRICT`, schema-wide. A parent with children cannot be removed. Deliberate removal still works from the leaves up; only implicit removal is prevented.

**Indexes.** One ordered index per list path — events and verifications by `(owner_id, problem_id, created_at, id)`, problems by `(owner_id, project_id, created_at, problem_id)` — plus the environment foreign key index. No index is a left prefix of another. Vector and full-text indexes belong to the retrieval phase.

**Storage boundary.** `MemoryRepository` in `src/repository/` is owner-scoped: the `OwnerContext` is fixed at creation and no method takes an owner argument. Ten operations — create/get Project, create/get Environment, create/get Problem, append/list Event, append/list Verification. It is a thin facade over `src/db/`, writes no SQL, and does not reinterpret error codes.

**Executor.** `DatabaseExecutor` is `query` and nothing else. A pool satisfies it, and so will a client checked out for a transaction, so Phase 2 can add transactions without changing anything below. The repository does not own a transaction.

**Layering.** domain ← service/API ← repository ← db ← PostgreSQL. `tests/architecture.test.ts` enforces it: the domain imports no driver, storage or vendor module and holds no SQL, and `pg` is named only in `db/config.ts`, `db/executor.ts` and `db/pool.ts`.

**Test.** `tests/integration/phase1.integration.test.ts` runs one problem from first suspicion to confirmed fix through the repository, plus the negative cases. 479 tests across 27 files.

## What is deliberately absent

Do not assume these exist, and do not add them outside the phase that owns them.

- Recording a successful Verification does **not** move a Problem to `VERIFIED`, and nothing prevents `VERIFIED` at the database level. That judgement is P2-06
- A duplicate `client_event_id` is refused, not replayed. Returning the original is P2-04 for Events and P2-05 for Verifications
- `version` exists on Problem and nothing increments it. Optimistic locking is P2-07
- No HTTP or MCP API, no update or delete path, no Relation, UsageLog or ChangeLog, no sanitization, no search, embedding or retrieval, no AI adapter, no UI

## Immediate objective

P2-01 — API application foundation.

Not started. HTTP/JSON API foundation with request validation, error mapping, auth context and logging as a shared layer; domain service separated from transport; an initial API versioning policy.

Its Definition of Done: a health endpoint and an authenticated endpoint work, invalid input returns a consistent error shape, and the transport layer does not touch the database directly.

Notes for whoever picks this up:
- The auth context is where P1-05's owner resolution meets a request. `MemoryRepository` is already owner-scoped, so a handler should obtain a repository, not an owner id
- Client credentials and their revocation are P3-04, not P2-01
- No HTTP framework is chosen yet; `pg` is currently the only runtime dependency

## Core MVP milestone

The Core MVP is not complete until the Phase 7 cross-project E2E succeeds: Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
