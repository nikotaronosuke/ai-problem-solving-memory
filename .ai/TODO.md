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

### P1-06 — DONE
Project table.

- [x] `public.projects` created by a new migration; earlier migrations unchanged
- [x] `project_id` is an application-issued UUID with no database default
- [x] `owner_id` is `not null` and references `owners.owner_id` with `on delete restrict`
- [x] `project_name` required, blank rejected in the application and by a CHECK
- [x] `repo` and `platform` nullable free-form text, provider-independent
- [x] create and get both require an `OwnerContext`; the owner never comes from input
- [x] owner-scoped reads, with another owner's project indistinguishable from absent

Definition of Done verified against the real database: a project created under owner A is readable by A and invisible to B in both directions; an unknown id and another owner's id give the identical absent answer while the row demonstrably exists; a project for a nonexistent owner is refused by the foreign key; deleting an owner with a project is refused by RESTRICT and permitted once the projects are gone; and after `db:reset` all four migrations reapplied in order.

Deliberately not done here: no project detection from repo or working directory, and no general repository layer (P1-12).

### P1-07 — DONE
Environment table.

- [x] `public.environments` created by a new migration; earlier migrations unchanged
- [x] `environment_id` is an application-issued UUID with no database default
- [x] conditions stored as a single `jsonb` object, not a column per field
- [x] object-only enforced in the application and by a database CHECK; empty object allowed
- [x] `owner_id` carried directly, so owner scope needs no join
- [x] owner/project consistency guaranteed by a composite foreign key
- [x] `on delete restrict` from project to environment
- [x] no `updated_at` and no update path — a snapshot is a point in time

Definition of Done verified against the real database: snapshots round-trip nested objects unchanged; empty objects store; arrays, strings, numbers and JSON null are refused by both the application and the CHECK; an environment for an unknown project and one for another owner's project fail with the identical error; a mismatched owner/project pair is refused by the composite foreign key even in raw SQL; owner A and B cannot see each other's environments in either direction, with another owner's environment indistinguishable from absent; deleting a project with environments is refused and permitted once they are gone; and after `db:reset` all five migrations reapplied in order.

Deliberately not done here: no update path, and no search indexes beyond the foreign key's.

### P1-08 — DONE
Problem table.

- [x] `public.problems` created by a new migration; earlier migrations unchanged
- [x] `problem_id` is an application-issued UUID with no database default
- [x] correctly related to Project and Environment, with owner scope enforced
- [x] P1-04 DOMAINs used for `status`, `fix_kind`, `confidence`, `freshness`
- [x] default flags as specified, and invalid enum values rejected
- [x] `version` present with a `>= 1` check, for later optimistic locking

Definition of Done verified against the real database: a new Problem starts `INVESTIGATING` / `LOW` / `CURRENT`, reads and writes enabled, not suppressed, not important, version 1, `fix_kind` null; blank title and symptoms are refused by both the application and CHECKs; a null environment, a version below one, and invalid `status`, `fix_kind`, `confidence` and `freshness` values are all refused; an unknown environment, another owner's environment and an environment under a different project fail with the identical error; a mismatched owner/project/environment triple is refused even in raw SQL; owner A and B cannot see each other's problems in either direction, with another owner's problem indistinguishable from absent; deleting an environment a Problem depends on is refused and permitted once the Problem is gone; there is no trigger on the table; and after `db:reset` all six migrations reapplied in order.

Deliberately not done here: no update path, no state transition rules, no VERIFIED enforcement and no `version` increment. Those are P2-06 and P2-07.

### P1-09 — DONE
Event table.

- [x] `public.events` created by a new migration; earlier migrations unchanged
- [x] append-only, with no update path and no application delete path
- [x] `event_id` is an application-issued UUID with no database default
- [x] `client_event_id` required, caller-issued, unique per `(owner_id, client_event_id)`
- [x] owner/problem consistency guaranteed by a composite foreign key
- [x] `summary` required and non-blank; the other text fields nullable and free-form
- [x] stable ordering by `created_at` then `event_id`

Definition of Done verified against the real database: multiple events append to one Problem and list in order, with ties broken deterministically; all six event types are accepted and an invalid one is refused by the DOMAIN; a duplicate `client_event_id` is refused, including when retried against a different Problem, while a different owner may reuse the same value; appending to an unknown Problem and to another owner's fail with the identical error; a mismatched owner/problem pair is refused even in raw SQL; owner A and B cannot see each other's events; deleting a Problem with events is refused and permitted once they are gone; and after `db:reset` all seven migrations reapplied in order.

Deliberately not done here: duplicate replay is P2-04, not a rejection turned into a returned original.

### P1-10 — DONE
Verification table.

- [x] `public.verifications` created by a new migration; earlier migrations unchanged
- [x] independent entity, attached to the Problem rather than to an Event
- [x] `verification_id` is an application-issued UUID with no database default
- [x] `result` is a required boolean, so a successful Verification can be found mechanically
- [x] `summary` required and non-blank; `verified_by` and `evidence_ref` nullable free-form text
- [x] `client_event_id` required, unique per `(owner_id, client_event_id)` within this table
- [x] owner/problem consistency via composite foreign key, reusing the P1-09 key

Definition of Done verified against the real database: multiple Verifications append to one Problem and list oldest first with deterministic tie-breaking; all six verification types are accepted and an invalid one is refused by the DOMAIN; both true and false results store; a duplicate `client_event_id` is refused, including against a different Problem, while another owner may reuse it and the same value may appear once as an Event and once as a Verification; a Verification stands alone with no Event recorded and keeps its full meaning; recording a successful Verification leaves the Problem `INVESTIGATING`; appending to an unknown Problem and to another owner's fail identically; owner A and B cannot see each other's Verifications; deleting a Problem with Verifications is refused and permitted once they are gone; and after `db:reset` all eight migrations reapplied in order.

Deliberately not done here: no automatic transition to `VERIFIED`, and no database-level ban on `VERIFIED` without a Verification. Both belong to P2-06. Duplicate replay is P2-05.

### P1-11 — DONE
Database integrity and initial indexes.

- [x] foreign key chain complete, every delete `restrict`, stated as schema-wide policy
- [x] owner scope carried on every table; no redundant owner foreign keys
- [x] ordered indexes for listing a problem's events and verifications
- [x] index for listing a project's problems
- [x] `client_event_id` unique per owner within each write table
- [x] NOT NULL policy audited across all six tables; no change needed
- [x] orphan prevention verified at every level

Definition of Done verified against the real database: an Event or Verification cannot be stored against a nonexistent Problem; no orphan can be created through any entry point, including raw SQL with mismatched owner/project/environment; deleting a parent with children is refused at every level while leaf-to-root deletion succeeds; the index catalogue matches intent with no index that is a left prefix of another; and after `db:reset` all nine migrations reapplied in order.

Two redundant indexes were found and dropped — `projects (owner_id)` and `environments (owner_id, project_id)` were each already covered by a unique index's left prefix on the same table.

Deliberately not done here: no hard-delete service, no new entity, no API, and no retrieval indexes.

### P1-12 — NEXT implementation task
Repository layer and minimal storage interface. Not started.

Depends on P1-06 through P1-11, all satisfied. The operations already exist in `src/db/`; this task gives them a coherent boundary that Phase 2 can build on, keeping PostgreSQL and Supabase specifics from spreading. Owner scope must be enforced at the boundary itself, not only by callers.

Resist widening the surface while reorganising it.

### P1-13 onward
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
