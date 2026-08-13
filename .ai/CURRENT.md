# CURRENT

Updated: 2026-08-13

## Current phase

Implementation Phase 1 — Foundation / Repository / Database: **COMPLETE**

Implementation Phase 2 — Core Memory API: **IN PROGRESS** (P2-01, P2-02, P2-03 done; P2-04 next)

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

## What exists now — Project and Environment API (P2-02)

| Method | Path |
| --- | --- |
| POST / GET | `/v1/projects` |
| GET / PATCH | `/v1/projects/:project_id` |
| POST / GET | `/v1/projects/:project_id/environments` |
| GET | `/v1/environments/:environment_id` |

**Nesting.** Environments are created and listed under their project so the project id has exactly one source. Accepting it in a path and a body would allow the two to disagree. A single environment is fetched by its own id, which already identifies one record.

**No delete, no environment update.** Nothing is deleted in this phase, and an Environment is a point in time — changed conditions are a new one.

**PATCH semantics.** Partial. An absent field is unchanged; an explicit `null` clears `repo` or `platform`; a blank string normalises to null. `owner_id`, `project_id` and the timestamps cannot be set. An empty patch is refused rather than executed, since it would still move `updated_at` and record a change that did not happen. It never upserts: patching an unknown id is a 404 and creates nothing.

**Ordering.** Lists are `created_at` then id, in the SQL itself. Repeated reads agree even when rows share a timestamp.

**Not-found unification.** A resource that does not exist and one belonging to another owner produce the same `ResourceNotFoundError` and the same 404 body. Listing a project's environments checks the project first, so another owner's project cannot answer with an empty list — which would read as "it exists and is empty".

**Snapshot boundary.** The request schema accepts only a JSON object at the top level, with free keys inside. An array, string, number, boolean or null is a 400 before the domain converter is reached.

**Layers.** `src/http/project-routes.ts` reads requests and shapes responses; `src/app/project-environment-service.ts` converts ids, decides not-found, and orchestrates. Transport never names a database error type — the architecture test enforces that.

## What exists now — Problem API (P2-03)

| Method | Path |
| --- | --- |
| POST / GET | `/v1/projects/:project_id/problems` |
| GET / PATCH | `/v1/problems/:problem_id` |

**Nesting.** Problems are created and listed under their project, for D-048's reason. A single Problem is read and patched by its own id. There is no unscoped `/v1/problems` collection and no delete.

**The relation check.** Creation names an environment in the body. It must exist, be the caller's, and belong to the project in the path. Unknown project, another owner's project, unknown environment, another owner's environment, and the caller's own environment under a different project are five different failures with one 404 body — a test compares them byte for byte.

**Starting state.** The caller declares none of it. `status`, `fix_kind`, `importance`, `confidence`, `freshness`, the memory flags and `version` come from the P1-08 column defaults, so a Problem cannot be filed already claiming to be verified. Sending any of them is a 400.

**What a patch may change.** Eleven fields: the five text fields, `importance`, `confidence`, `freshness`, `memory_read_enabled`, `memory_write_enabled`, `suppressed`. Partial semantics are P2-02's — absent leaves alone, `null` clears, blank normalises to null, an empty patch is refused, and it never upserts.

**What it may not.** `status` is not PATCHable: transitions are P2-06's and `VERIFIED` has to be earned. `fix_kind` belongs to P2-12, and `version` is response-only until P2-07 makes it an optimistic lock — there is no `expected_version` and nothing increments it. All three are 400, not silently dropped.

**Independent flags.** Setting `suppressed` does not disable reads; setting `importance` does not raise confidence; `freshness` moves nothing else. Every combination is representable, and an integration test asserts the couplings do not exist.

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

**Storage boundary.** `MemoryRepository` in `src/repository/` is owner-scoped: the `OwnerContext` is fixed at creation and no method takes an owner argument. Fifteen operations — create/get/list/update Project, create/get/list Environment, create/get/list/update Problem, append/list Event, append/list Verification. It is a thin facade over `src/db/`, writes no SQL, and does not reinterpret error codes.

**Executor.** `DatabaseExecutor` is `query` and nothing else. A pool satisfies it, and so will a client checked out for a transaction, so Phase 2 can add transactions without changing anything below. The repository does not own a transaction.

**Layering.** domain ← service/API ← repository ← db ← PostgreSQL. `tests/architecture.test.ts` enforces it: the domain imports no driver, storage or vendor module and holds no SQL, and `pg` is named only in `db/config.ts`, `db/executor.ts` and `db/pool.ts`.

**Test.** `tests/integration/phase1.integration.test.ts` runs one problem from first suspicion to confirmed fix through the repository, plus the negative cases. 730 tests across 33 files.

## What is deliberately absent

Do not assume these exist, and do not add them outside the phase that owns them.

- Recording a successful Verification does **not** move a Problem to `VERIFIED`, and nothing prevents `VERIFIED` at the database level. That judgement is P2-06
- A duplicate `client_event_id` is refused, not replayed. Returning the original is P2-04 for Events and P2-05 for Verifications
- `version` exists on Problem and nothing increments it. It is response-only, no endpoint accepts it, and there is no `expected_version`. Optimistic locking is P2-07
- Nothing changes a Problem's `status` or `fix_kind`. The Problem PATCH refuses both. Transitions are P2-06, close and review P2-12
- No Event or Verification endpoints. Those are P2-04 onward
- No delete anywhere, no Environment update, no MCP, no Relation, UsageLog or ChangeLog, no sanitization, no search, embedding or retrieval, no AI adapter, no UI
- No pagination, filtering or search on list endpoints
- No OpenAPI generation. Response schemas exist per route and are reusable for P2-13, but nothing generates a document

## Immediate objective

P2-04 — Event API.

Not started.

Notes for whoever picks this up:
- The pattern is established: add repository operations if needed, extend or add an application service, register routes in the `/v1` scope, map records explicitly in `src/http/resources.ts`
- `appendEvent` and `listEvents` already exist on the repository, and `events (owner_id, problem_id, created_at, event_id)` indexes the list path
- The open decision is `client_event_id`. Today a duplicate is refused with a database error the application layer has no HTTP meaning for. Whether a retry returns the original event is this task's call, and it decides whether the endpoint is idempotent
- Events are append-only (D-026): no update, no delete, and no `updated_at` to move
- The repository now exposes 15 operations

## Core MVP milestone

The Core MVP is not complete until the Phase 7 cross-project E2E succeeds: Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
