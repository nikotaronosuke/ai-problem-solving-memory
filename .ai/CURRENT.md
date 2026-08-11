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

P1-01, P1-02 and P1-03 are complete. P1-04 has not been started.

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

## Immediate objective

P1-04 — shared enum / domain type definitions, consistent between application types and database constraints.

Not started. P1-04 and P1-05 can run in parallel once started.

Note for whoever picks this up: the baseline migration deliberately defines no schema. P1-04 is where the first real DDL lands.

## Module boundary reminder

This repository is the Problem-Solving Memory service only. Tool Gateway, shared credential management, the shared Approval Engine, Skill Registry, Workflow Engine, Model Router and the OS-wide audit warehouse stay outside it. See `CLAUDE.md`.

## Core MVP milestone

The Core MVP is not considered complete until the Phase 7 cross-project E2E succeeds:
Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
