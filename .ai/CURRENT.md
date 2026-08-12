# CURRENT

Updated: 2026-08-12

## Current implementation state

Product design and implementation planning are complete in the private specification repository.

Private source of truth:
- `nikotaronosuke/ai-problem-solving-memory-spec/docs/spec/final-mvp-spec.md`
- `nikotaronosuke/ai-problem-solving-memory-spec/docs/spec/mvp-os-boundary-addendum.md`
- `nikotaronosuke/ai-problem-solving-memory-spec/docs/implementation/mvp-roadmap.md`
- `nikotaronosuke/ai-problem-solving-memory-spec/docs/implementation/phase1-task-breakdown.md`

## Current phase

Implementation Phase 1 — Foundation / Repository / Database

Status: IN PROGRESS

P1-01 through P1-13 are complete. P1-14 has not been started.

## P1-01 — DONE

The TypeScript / Node.js foundation exists in this repository. Memory domain behavior is deliberately not implemented yet.

Established:
- npm as the package manager, with `package-lock.json` committed
- TypeScript in strict mode, ESM (`"type": "module"`, `NodeNext` resolution)
- `tsconfig.json` for typecheck (`src` + `tests`), `tsconfig.build.json` for emit to `dist/`
- ESLint 9 flat config with type-aware `typescript-eslint` rules
- Prettier for formatting; `README.md`, `CLAUDE.md` and `.ai/` are excluded as hand-maintained prose
- Vitest as the test runner, tests under `tests/`
- `.gitattributes` fixing the working tree to LF so format checks behave the same on every platform
- `.env.example` with placeholders only; `.env` is git-ignored
- Directory structure: `src/`, `tests/`, `db/`, `docs/`

Fixed commands:
- `npm run typecheck`
- `npm run lint`
- `npm run format` / `npm run format:check`
- `npm test`
- `npm run build` / `npm start` / `npm run dev`
- `npm run check` runs typecheck + lint + format:check + test

Current runtime behavior is limited to loading and validating `NODE_ENV` / `LOG_LEVEL` and printing a startup line. Environment reading is plain deterministic code, not model inference.

See `docs/development.md` for setup and command details.

## P1-02 — DONE

AI development operating files. Satisfied by `CLAUDE.md`, `.ai/CURRENT.md`, `.ai/DECISIONS.md` and `.ai/TODO.md`, which already existed and were verified against the private task breakdown. No new operating files were needed; `.ai/sessions/` is optional and was not created.

## P1-03 — DONE

Supabase / PostgreSQL connection and migration foundation. No domain schema — the database is reachable and migrations run, nothing more.

Established:
- Supabase CLI pinned as a devDependency (no global install); run through npm scripts
- Local stack via Supabase CLI + Docker. No cloud project, no `login`, no `link`, no `db push`
- `supabase/config.toml` committed; only the services this project uses are enabled. Auth, Storage, Realtime, Edge Runtime, local SMTP and analytics are off
- `supabase/migrations/` is the schema source of truth. Baseline migration adds no schema on purpose
- `pg` (node-postgres) with a connection pool for application access
- `src/db/` is the database boundary: `config.ts` resolves configuration, `pool.ts` owns lifecycle, `health.ts` probes reachability. Importing any of them opens no connection
- `DATABASE_URL` read only from the environment, validated where a connection is actually opened, so non-database code and tests run without it
- Connection strings never reach an error message, log line or test fixture
- While `NODE_ENV=test`, a non-local database host is refused

Fixed commands:
- `npm run supabase:start` / `npm run supabase:stop`
- `npm run db:status`
- `npm run db:reset` — rebuilds the local database from migrations
- `npm run db:migration:new <name>`
- `npm run db:check` — opens a pool, runs `select 1`, closes it

Verified end to end: start → migration applied → `select 1` from the service → `db reset` → migrations reapplied → `select 1` again.

Integration tests run against the local database when `DATABASE_URL` is set and skip cleanly when it is not.

## P1-04 — DONE

Shared value sets, defined once in TypeScript and enforced identically by PostgreSQL. Still no table.

Established:
- `src/domain/enums.ts` declares six sets as readonly tuples with types derived from them, so each value is written once: `ProblemStatus`, `FixKind`, `EventType`, `VerificationType`, `Confidence`, `Freshness`
- The database enforces the same sets through text-backed DOMAINs with named CHECK constraints. PostgreSQL native ENUM types are not used
- `src/db/enum-domains.ts` is the single place pairing each TypeScript set with its DOMAIN and constraint name
- The P1-03 baseline migration is unchanged; the DOMAINs are added by a new migration

Drift between the two sides is a test failure, not a silent divergence. The integration test casts every TypeScript value through its DOMAIN against the real database, and compares the constraint read back from PostgreSQL's own catalog with the TypeScript set. Adding a value on either side without the other fails. This was verified by injecting a TypeScript-only value and observing the failure.

Rejection is exact: lowercase, mixed case, padded, empty and unknown values are all refused. NULL is allowed, because nullability belongs to a column rather than to a value set.

## P1-05 — DONE

Ownership boundary and the minimal owner model. The first table exists: `public.owners`.

Established:
- `owner_id` is a UUID the Memory Server issues. It is not an AI vendor account id, a GitHub user id, or derived from any external provider
- `public.owners` holds `owner_id uuid primary key` and `created_at` only. No email, username, provider, role or team. The column has no database-side default, so ownership is always supplied explicitly
- `OwnerId` in `src/domain/owner.ts` is a branded string, so an arbitrary string cannot stand in for an owner. Values are validated as UUIDs and normalised to lowercase, which is how PostgreSQL returns them
- `OwnerContext` is also branded and only produced by `resolveOwnerContext`, so owner-scoped work cannot begin before ownership is settled
- Resolution reads `MEMORY_OWNER_ID` and fails closed with three distinguishable reasons: `MISSING`, `INVALID`, `UNKNOWN`. A valid UUID with no row is still a refusal
- The read path takes an `OwnerContext` and can only return that owner. There is no application API accepting an arbitrary owner id, so reading across the boundary is not expressible
- `npm run owner:bootstrap` creates the local owner and is idempotent; it never updates or removes a row, and creates no credential

Supabase Auth remains disabled and no RLS policy is defined. Owner scoping is enforced at the application boundary in this phase.

Scope held: this is the local development path only. HTTP request auth context is P2-01, and client credentials and revocation are P3-04.

## P1-06 — DONE

The Project table and the first owner-scoped data. Tables are now `owners` and `projects`.

Established:
- `public.projects` holds `project_id`, `owner_id`, `project_name`, `repo`, `platform`, `created_at`, `updated_at`
- `project_id` is an application-issued UUID with no database default, matching `owner_id`. It is not derived from a repository or hosting provider
- `owner_id` is `not null` and references `owners.owner_id` with `on delete restrict`, so deleting an owner that still has projects fails rather than quietly taking Memory with it
- `project_name` is required, and blank is rejected in the application and by a database CHECK
- `repo` and `platform` are nullable free-form text. A project may have no repository and an undetermined platform; neither is an enum, a URL, unique, or tied to a provider
- `createProject` and `getProject` both take an `OwnerContext`. The owner comes from the context, never from caller input, and reads are scoped by `owner_id` alongside `project_id`
- Another owner's project reads as absent, identically to one that does not exist, so the answer cannot confirm the id exists
- `ProjectId` is branded and validated like `OwnerId`; the shared UUID rule now lives in `src/domain/uuid.ts` rather than being restated per entity

Detecting a project from repo or working directory is deliberately not implemented. The general repository layer remains P1-12.

## P1-07 — DONE

The Environment table. Tables are now `owners`, `projects` and `environments`.

Established:
- `public.environments` holds `environment_id`, `owner_id`, `project_id`, `snapshot`, `created_at`
- An Environment is a point in time. There is no `updated_at` and no update path: changed conditions are a new snapshot, not an edit to an old one
- Conditions live in a single `jsonb` object rather than a column per field. Which conditions matter differs by project and problem, so columns would mean demanding values nobody has, or migrating whenever a new one appears
- Only a JSON object is accepted, enforced in the application and by a database CHECK on `jsonb_typeof`. Arrays and scalars are refused on both sides
- An empty object is allowed, meaning the relevant conditions have not been captured yet. Forcing a placeholder would record something untrue
- `owner_id` is carried directly, so owner-scoped reads need no join
- Owner and project are checked together by a composite foreign key to `projects (owner_id, project_id)`, so an environment cannot pair one owner with another owner's project. This also guarantees the owner exists transitively, so no separate owner foreign key is needed
- `on delete restrict`, so a project with environments cannot be deleted until they are gone
- Creating against an unknown project and against another owner's project fail identically, so the outcome cannot reveal whether someone else's project id is real

The snapshot is explicitly not a dependency dump, a log store or a place for secrets.

## P1-08 — DONE

The Problem table, the centre of the model. Tables are now `owners`, `projects`, `environments` and `problems`.

Established:
- `public.problems` holds every field the specification lists, with `problem_id` an application-issued UUID and no database default
- First table to use the P1-04 DOMAINs as column types: `status`, `fix_kind`, `confidence`, `freshness`
- `environment_id` is `not null`. When conditions are not known the Environment carries an empty snapshot, so "not known yet" has one representation rather than two
- Owner, project and environment are checked as one triple by a composite foreign key to `environments (owner_id, project_id, environment_id)`. A Problem cannot reference another owner's environment, nor one under a different project
- `title` and `symptoms` are required and non-blank in the application and by database CHECKs. `symptoms` is free-form text, not an array or structured shape
- `problem_domain`, `suspected_boundary` and `source_ai` are nullable free-form text; blank normalises to null
- Initial values come from database defaults, not from caller input: `INVESTIGATING`, confidence `LOW`, freshness `CURRENT`, reads and writes enabled, not suppressed, not important, `version` 1
- `importance` is a boolean, independent of `confidence`
- `version` exists with a `>= 1` check, and nothing increments it yet
- `updated_at` exists with no trigger

Storage only. Status transitions, the rule that `VERIFIED` requires a successful Verification, and optimistic locking are Phase 2 (P2-06, P2-07), and are deliberately not anticipated here.

## P1-09 — DONE

The Event table. Tables are now `owners`, `projects`, `environments`, `problems` and `events`.

Established:
- `public.events` holds every field the specification lists, with `event_id` an application-issued UUID and no database default
- Append-only. There is no update path, no `updated_at`, no trigger and no application delete path. A later correction is another Event, which is what `USER_CORRECTION` is for
- `client_event_id` is a required UUID the caller mints before its first attempt and reuses on retry. `appendEvent` never generates one: an id minted per attempt would differ on every retry and protect nothing
- Uniqueness is `(owner_id, client_event_id)` — scoped to the owner, not the Problem, so the same write cannot land twice even if retried against a different Problem, and not global, which would couple separate owners' namespaces
- Owner and problem are checked as one pair by a composite foreign key to `problems (owner_id, problem_id)`, with `on delete restrict`
- `summary` is required and non-blank in the application and by a database CHECK
- `result`, `reason`, `source_ai` and `evidence_ref` are nullable free-form text; blank normalises to null
- `evidence_ref` points at the material rather than containing it, and is deliberately unstructured in the MVP
- Listing orders by `created_at` then `event_id`, so events sharing a timestamp still come back in a stable order

P1-09 only refuses a duplicate `client_event_id`. Turning a duplicate into a replay of the original result is P2-04.

`ClientEventId` is a shared domain type, ready for Verification to reuse.

## P1-10 — DONE

The Verification table. All six Phase 1 tables now exist: `owners`, `projects`, `environments`, `problems`, `events` and `verifications`.

Established:
- A Verification is not the fix. It is the record of something actually checking whether the state holds, kept as a separate entity from the FIX Event
- It attaches to the Problem directly, never to an Event. `src/db/verifications.ts` imports nothing from the event module, and there is no `event_id` column. A Problem may have a Verification and no Events at all
- `result` is `boolean not null`: true means carried out and confirmed, false means carried out and not confirmed. A boolean rather than prose because P2-06 has to answer "is there a successful Verification?" mechanically
- `summary` is required and non-blank in the application and by a database CHECK
- `verified_by` is nullable free-form text — who or what performed the check. Null when unknown, never a plausible-looking placeholder that would misrepresent the evidence
- `evidence_ref` follows the Event shape: a nullable free-form reference to material, not the material
- `client_event_id` reuses the shared `ClientEventId`, with `(owner_id, client_event_id)` unique **within this table**. The same value may appear once as an Event and once as a Verification, since those are separate writes
- Owner and problem are checked by a composite foreign key reusing the key P1-09 added to `problems`; no second key was created
- Append-only: no `updated_at`, no trigger, no update path

`ProblemNotAvailableError` and `DuplicateClientEventIdError` moved to `src/db/errors.ts` so Event and Verification share them without either depending on the other. Event behaviour is unchanged.

Recording a successful Verification does **not** move the Problem to `VERIFIED`, and nothing prevents `VERIFIED` at the database level. That transition is P2-06's decision, made after checking the evidence exists.

## P1-11 — DONE

Schema-wide integrity and index review. No new entity, value set or column — the audit found the foreign keys, delete actions and NOT NULL policy already correct, so the migration changes only indexes.

Audited and confirmed unchanged:
- All five foreign keys form a complete chain and every one deletes with `restrict`. That is now the stated schema-wide policy rather than five separate decisions
- Owner existence is guaranteed transitively along the composite chain; no redundant owner foreign keys exist
- `client_event_id` is `not null` and unique per `(owner_id, client_event_id)` in each of `events` and `verifications`, with the namespaces deliberately separate
- Required and nullable columns match the intended policy on all six tables. Nothing was tightened for looking safe — a nullable column is nullable because the value can genuinely be unknown

Index changes:
- `events`: replaced `(owner_id, problem_id)` with `(owner_id, problem_id, created_at, event_id)`, so one index covers the list query's filter and its sort. The left prefix still serves the foreign key and RESTRICT check
- `verifications`: the same, as `(owner_id, problem_id, created_at, verification_id)`
- `problems`: added `(owner_id, project_id, created_at, problem_id)` for listing a project's problems. The existing `(owner_id, project_id, environment_id)` index stays — it serves the environment foreign key, a different path
- Dropped two indexes the audit found redundant: `projects (owner_id)` and `environments (owner_id, project_id)` were both already covered by the left prefix of a unique index on the same table

`tests/db/integrity.integration.test.ts` checks the schema as a whole: the foreign key list, every delete action, orphan prevention at each level, deletion succeeding in leaf-to-root order, required and optional column sets, `client_event_id` uniqueness, the index catalogue, and that no index is a left prefix of another.

Vector, embedding and full-text indexes remain with the retrieval phase.

## P1-12 — DONE

The repository layer. No new storage behaviour, no migration, no schema change — the existing database functions were not rewritten, only given a boundary.

Established:
- `MemoryRepository` in `src/repository/`, created by `createMemoryRepository(executor, ownerContext)`
- A repository is owner-scoped. `OwnerContext` is fixed at creation, and **no method takes an owner argument**, so a caller cannot name a different owner. The service layer uses an already-scoped repository rather than passing an owner to every query
- Ten operations, the Phase 1 minimum: create/get Project, create/get Environment, create/get Problem, append/list Event, append/list Verification
- A thin facade. No SQL is written in the repository, and PostgreSQL error codes are not reinterpreted — error mapping stays in the database layer so two layers cannot disagree about what a failure means
- `DatabaseExecutor` in `src/db/executor.ts` is the minimal boundary: `query` and nothing else. Entity functions now take an executor rather than a pool, so the same code runs against a pool or against a client checked out for a transaction
- The repository does not own a transaction. It uses the executor it is given; a service that needs `begin`/`commit` builds a repository over its client, and nothing below changes
- `createPool` / `closePool` and health keep taking `DatabasePool` — pool lifecycle is a different concern and was left alone

Architecture is checked, not assumed. `tests/architecture.test.ts` verifies that `src/domain/` imports no driver, storage or vendor module and contains no SQL; that the repository writes no SQL and imports no driver; that its public surface exposes no pool or client type; and that only `db/config.ts`, `db/executor.ts` and `db/pool.ts` name `pg` at all.

## P1-13 — DONE

The Phase 1 integration test. No source change, no migration, no new behaviour — `src/` is untouched.

`tests/integration/phase1.integration.test.ts` follows one problem from first suspicion to confirmed fix: owner context, Project, Environment, Problem, then HYPOTHESIS → ATTEMPT → DEAD_END → FIX events, a successful Verification, and a re-read of everything from the database rather than reuse of the returned objects.

Every step of the normal path goes through `MemoryRepository`. Raw SQL appears only in three helpers at the bottom of the file — two constraint probes and cleanup — and never in the scenario itself.

The negative cases all hold: another owner cannot read the Project, Environment, Problem, events or verifications; cannot append an Event or Verification to the Problem, and gets the same error as for a Problem that does not exist; a replayed `client_event_id` is refused with nothing written; an event type outside the value set is refused by the database DOMAIN; and an event against a nonexistent Problem is refused by the foreign key.

The boundary from P1-10 holds under a full flow: after a successful Verification the Problem is still `INVESTIGATING` at version 1. Nothing in Phase 1 moves it to `VERIFIED`.

The fixture is self-contained. It generates its own owner every run, never touches the developer's owner or anything a previous run left, and removes only what it created, leaf to root. Verified by running it against a database freshly reset with no bootstrap owner present, after which every table was empty again.

## Immediate objective

P1-14 — documentation and the Phase 1 completion review.

Not started. This closes the phase.

Notes for whoever picks this up:
- Add the minimum needed to `README.md` about how the implementation currently works — P1-01 deliberately left the README alone for this task
- Update `.ai/CURRENT.md` and `.ai/TODO.md` to a Phase 2 starting state, and record any Phase 1 decisions not yet written down
- Re-run migrations, tests, typecheck and lint; check for secrets; review `git diff` and `git status`
- Then check the Phase 1 Definition of Done in the private breakdown item by item before declaring the phase complete

## Module boundary reminder

This repository is the Problem-Solving Memory service only. Tool Gateway, shared credential management, the shared Approval Engine, Skill Registry, Workflow Engine, Model Router and the OS-wide audit warehouse stay outside it. See `CLAUDE.md`.

## Core MVP milestone

The Core MVP is not considered complete until the Phase 7 cross-project E2E succeeds:
Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
