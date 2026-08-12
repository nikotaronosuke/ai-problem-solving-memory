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

P1-01 through P1-07 are complete. P1-08 has not been started.

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

## Immediate objective

P1-08 — the Problem table.

Not started. Problem is the centre of the model and the largest table in Phase 1: `id`, `owner_id`, `project_id`, `environment_id`, `title`, `status`, `fix_kind`, `problem_domain`, `symptoms`, `suspected_boundary`, `source_ai`, `importance`, `confidence`, `freshness`, the three flags, `version`, and timestamps.

Notes for whoever picks this up:
- This is the first table to use the P1-04 DOMAINs as column types
- `version` exists from the start for later optimistic locking, even though nothing uses it in Phase 1
- `memory_read_enabled` and `memory_write_enabled` default true, `suppressed` defaults false; read/write control and suppression are separate concepts
- Full `VERIFIED` consistency is Phase 2, but the schema must not make it impossible

## Module boundary reminder

This repository is the Problem-Solving Memory service only. Tool Gateway, shared credential management, the shared Approval Engine, Skill Registry, Workflow Engine, Model Router and the OS-wide audit warehouse stay outside it. See `CLAUDE.md`.

## Core MVP milestone

The Core MVP is not considered complete until the Phase 7 cross-project E2E succeeds:
Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
