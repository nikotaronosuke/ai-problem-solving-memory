# TODO

Updated: 2026-08-12

## NOW — Implementation Phase 1

Follow the private task breakdown:
`nikotaronosuke/ai-problem-solving-memory-spec/docs/implementation/phase1-task-breakdown.md`

### P1-01 — DONE
Public implementation repository foundation:
- [x] inspect current repository state
- [x] initialize TypeScript / Node.js implementation structure
- [x] choose/fix package manager (npm, lockfile committed)
- [x] configure typecheck (`npm run typecheck`)
- [x] configure lint (`npm run lint`)
- [x] configure format (`npm run format` / `npm run format:check`)
- [x] configure test runner (`npm test`, Vitest)
- [x] add `.env.example`
- [x] establish minimal `src / tests / db / docs` structure
- [x] verify secret hygiene

Definition of Done verified: dependency install, typecheck, lint, format check and tests all succeed; no secrets in the repository.

### P1-02 — DONE
AI development operating files. Verified against the private task breakdown; satisfied by files that already existed, so no new operating files were added.

- [x] `CLAUDE.md`
- [x] `.ai/CURRENT.md`
- [x] `.ai/DECISIONS.md`
- [x] `.ai/TODO.md`

`.ai/sessions/` is optional in the task breakdown and no current rule requires it, so it was not created.

All five required rules have a corresponding statement in `CLAUDE.md`: read the source-of-truth spec and `.ai/` at session start; update CURRENT / TODO / DECISIONS at session end; do not settle a specification change in code alone; push only on explicit instruction; stop and confirm when a change would break the Memory product invariants.

Definition of Done verified: a new AI session can establish its position from `CLAUDE.md`, `.ai/CURRENT.md` and `.ai/TODO.md`, with `docs/development.md` supplying the commands — no verbal explanation required.

### P1-03 — DONE
Supabase / PostgreSQL connection and migration foundation.

- [x] PostgreSQL connected as the persistent source of truth
- [x] Supabase usable as the first-choice MVP environment (local stack, no cloud project)
- [x] DB connection settings read only from the environment
- [x] migration creation and application fixed (`supabase/migrations/`, Supabase CLI)
- [x] local and test environments depend on no production secret
- [x] Supabase CLI pinned as a devDependency, not a global install

Definition of Done verified: the service reaches the database (`select 1`), `db reset` replays every migration onto a clean database and the service reaches it again, and no connection secret is in the repository.

Deliberately not done here: no domain schema. The baseline migration adds none.

### P1-04 — DONE
Shared enum / domain type definitions, kept consistent between application types and database constraints.

- [x] six value sets defined in TypeScript as readonly tuples with derived types
- [x] values available at runtime, not only as types
- [x] the same sets enforced in PostgreSQL as text-backed DOMAINs with CHECK constraints
- [x] no PostgreSQL native ENUM type used
- [x] added by a new migration; the P1-03 baseline is unchanged
- [x] invalid values rejected by the database, including case and whitespace variants

Definition of Done verified: every application value is accepted by its DOMAIN against the real database, representative invalid values are rejected, and a divergence between TypeScript and the database fails the test suite. Confirmed by injecting a TypeScript-only value and observing the failure.

Deliberately not done here: no table. The DOMAINs exist to be reused as column types from P1-06 onward.

### P1-05 — DONE
Owner boundary and the minimal owner model.

- [x] `owner_id` is a Memory Server managed UUID, independent of any AI vendor or provider account
- [x] `public.owners` created by a new migration; P1-03 and P1-04 migrations unchanged
- [x] `OwnerId` validated and branded, so an arbitrary string is not an owner
- [x] `OwnerContext` resolved from `MEMORY_OWNER_ID`, only for owner-aware operations
- [x] fail closed on missing, malformed and unknown owner, as distinguishable reasons
- [x] `npm run owner:bootstrap`, idempotent and non-destructive
- [x] owner-scoped reads go through the context and cannot name another owner

Definition of Done verified: all three failure modes and the success path were exercised against the real database; owner A and owner B each read only their own record while both rows exist; bootstrap run twice left `created_at` unchanged; and after `db:reset` the three migrations reapplied in order, resolution failed closed until bootstrap ran again, then succeeded.

Deliberately not done here: no credential, token, session or provider mapping. HTTP request auth context is P2-01; credential lifecycle and revocation are P3-04.

### P1-06 — NEXT implementation task
Project table. Not started.

Depends on P1-04 and P1-05, both satisfied. Every Project belongs to an owner, and access outside that owner must not be possible. Automatic detection of a project from repo or working directory is not part of this task.

### P1-07 onward
Proceed only after dependencies and each task's Definition of Done are satisfied.

Phase 1 order:
`P1-01 → P1-02 → P1-03 → P1-04/P1-05 → P1-06 → P1-07 → P1-08 → P1-09/P1-10 → P1-11 → P1-12 → P1-13 → P1-14`

## BLOCKED

None currently documented.

## SETTLED — local stack network exposure

Docker publishes the local Supabase ports on all interfaces, not only loopback. Enabling fewer services reduced the published ports to three, but the binding address is a Docker daemon setting, not a repository one.

Decided: not a blocker. The Docker daemon bind configuration is left unchanged, and the operating rule is to stop the local stack when it is not in use (`npm run supabase:stop`). Revisit only if the stack ever needs to run on an untrusted network.

## LATER

Implementation Phases 2–9 are already broken down in the private specification repository. Do not begin them before Phase 1 Definition of Done is satisfied unless the specification is deliberately revised.
