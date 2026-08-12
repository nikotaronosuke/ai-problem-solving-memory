# CURRENT

Updated: 2026-08-13

## Current phase

Implementation Phase 1 — Foundation / Repository / Database: **COMPLETE**

Implementation Phase 2 — Core Memory API: **IN PROGRESS** (P2-01 done, P2-02 next)

## Source of truth

Private specification repository `nikotaronosuke/ai-problem-solving-memory-spec`:
- `docs/spec/final-mvp-spec.md`
- `docs/spec/mvp-os-boundary-addendum.md`
- `docs/implementation/mvp-roadmap.md`
- `docs/implementation/phase2-task-breakdown.md`

## What exists now — HTTP (P2-01)

**Transport.** Fastify 5 in `src/http/`. `buildMemoryHttpApp(dependencies)` returns an instance and starts nothing — no listener, no pool, no signal handler — which is what lets tests drive the real application through `inject()` rather than a port. Composition and lifecycle live in `src/index.ts`.

**Application layer.** `src/app/` sits between transport and storage: a health service and a request-context service. Transport imports neither `pg` nor `src/db/`, so what a client is allowed to learn stays a product decision rather than a consequence of how the driver answers.

**Versioning.** The Memory JSON API is under `/v1`. `/health` sits outside it, since whether the process is serving is not part of the API contract. No header or query negotiation.

**JSON contract.** snake_case, shaped deliberately per response. Internal records are camelCase and are never serialised straight out, so an implementation detail cannot become the contract by accident.

**Errors.** One envelope everywhere: `{ error: { code, message }, request_id }`. Codes are `INVALID_REQUEST`, `UNAUTHENTICATED`, `NOT_FOUND`, `INTERNAL_ERROR`. Fastify and Ajv error objects never reach a client, and an internal failure returns no stack, driver message or connection string.

**Auth.** `/v1/me` requires an owner. A `preHandler` on the `/v1` scope calls the request-context service, which resolves the owner and hands back an owner-scoped `MemoryRepository` — a handler never sees an owner id it could pass anywhere. Missing, malformed and unknown owners are three entries in the log and one indistinguishable 401 to the client, so the endpoint is not an existence oracle.

**Not a credential.** An owner id supplied in a header or body authenticates nothing. Real client credentials are P3-04; this phase uses the same local `MEMORY_OWNER_ID` identity Phase 1 established, behind one swappable function.

**Config.** `HOST` and `PORT`, defaulting to `127.0.0.1:3000`. Loopback by default because this holds one person's memory. Blank `HOST` is refused rather than defaulted; `PORT` must be digits in 1–65535.

**Logging.** Fastify's logger at `LOG_LEVEL`, with authorization, cookie, api-key and set-cookie headers redacted. Bodies are not logged. Tests pass `logger: false`.

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
- No Memory API routes yet: `/health` and `/v1/me` are the whole HTTP surface. Project, Environment, Problem, Event and Verification endpoints are P2-02 onward
- No MCP, no update or delete path, no Relation, UsageLog or ChangeLog, no sanitization, no search, embedding or retrieval, no AI adapter, no UI
- No OpenAPI generation. Response schemas exist per route and are reusable for P2-13, but nothing generates a document

## Immediate objective

P2-02 — Project / Environment API.

Not started. Project create/get/list/update and Environment create/get/list, with owner scope enforced on every endpoint.

Notes for whoever picks this up:
- Register routes inside the existing `/v1` plugin scope in `src/http/app.ts`; the authentication `preHandler` already applies there and hands the handler an owner-scoped repository
- The repository currently exposes create/get only. List and update are new operations and need adding at the repository boundary too — that is real work, not a pass-through
- Request bodies use Fastify JSON Schema. Keep `additionalProperties: false` refusing rather than silently dropping, as the shared Ajv config already does
- Response fields are snake_case and shaped explicitly. Do not serialise a record directly
- P1-07's environment snapshot converter accepts any non-array object, including class instances. HTTP input is parsed JSON, so this is the natural place to constrain it

## Core MVP milestone

The Core MVP is not complete until the Phase 7 cross-project E2E succeeds: Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
