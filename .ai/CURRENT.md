# CURRENT

Updated: 2026-08-13

## Current phase

Implementation Phase 1 — Foundation / Repository / Database: **COMPLETE**

Implementation Phase 2 — Core Memory API: **IN PROGRESS** (P2-01 … P2-12 done; P2-13 next)

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

**What it may not.** `status` is not PATCHable: transitions have their own route and `VERIFIED` has to be earned. `fix_kind` is written only by closing (P2-12). `version` cannot be assigned either — it is the server's to move — though since P2-07 a patch must carry `expected_version` saying which version it acts on. All three of `status`, `fix_kind` and `version` are 400, not silently dropped.

**Independent flags.** Setting `suppressed` does not disable reads; setting `importance` does not raise confidence; `freshness` moves nothing else. Every combination is representable, and an integration test asserts the couplings do not exist.

## What exists now — Event API (P2-04)

| Method | Path |
| --- | --- |
| POST / GET | `/v1/problems/:problem_id/events` |

**Append-only, and still is.** No single-event read, no update, no delete, no `updated_at`, no trigger. A later correction is a `USER_CORRECTION` event. P2-04 did not make an Event mutable to get idempotency.

**What a caller supplies.** `event_type`, `summary` and `client_event_id` are required; `result`, `reason`, `source_ai` and `evidence_ref` are optional. The problem comes from the path. `problem_id`, `owner_id`, `event_id` and `created_at` in the body are 400.

**Retry returns the original.** A second append carrying the same `client_event_id` returns the event the first one wrote — same 201, same body, same `event_id` and `created_at`. The status does not distinguish the two, because the client wanted the event, not the history of its own connection.

**First write wins.** If the retry's payload differs, the original is returned unchanged. Applying the new payload would edit an append-only record; writing a second event would hide a client bug worth surfacing.

**The key is the owner's, not the problem's.** `(owner_id, client_event_id)`. Retrying against a different problem replays the original, `problem_id` and all, so the client can see it reused a key. Two owners may use the same value independently.

**Ownership first.** Both routes confirm the problem is the caller's before anything else. The unique index is evaluated before the foreign key, so an unchecked append could otherwise replay an event to someone with no right to it — idempotency is never a way past owner scope. Listing another owner's problem is a 404, not an empty list.

**The race.** The insert is attempted and the unique index decides; the original is read back only after it refuses. A test sends the same key six times at once, with the pool's connections opened first so the attempts really are simultaneous, and it was confirmed to fail against a read-then-write append. That handling is confined to `src/db/events.ts`.

## What exists now — Closing a Problem (P2-12)

| Method | Path |
| --- | --- |
| POST | `/v1/problems/:problem_id/close` |

**What it is for.** Recording how work on a Problem ended, all at once: where it settles, whether the fix addressed the cause, and what the next reader should know. Ending a Problem is usually more than moving its status, which is why it is a surface of its own rather than fields hung on a transition (D-097).

**Three targets only.** `VERIFIED`, `PAUSED`, `CLOSED_UNRESOLVED`. `INVESTIGATING` and `FIX_CANDIDATE` are working states and are a 400 here — the transition route still performs every move, closing ones included, for a caller with nothing to record.

**No relaxation for being higher-level.** The same `decideTransition` and the same evidence check. `VERIFIED` still comes only from `FIX_CANDIDATE` and still needs a successful Verification of the Problem's own; a terminal Problem cannot be closed again, so this is not a way to revise a conclusion (D-098). The version is checked before the rule, as in the transition service.

**`fix_kind`.** Written here and nowhere else in this phase. Absent leaves it, `null` clears it, and it stays a separate axis from status in both directions — verified with no fix kind stated is legitimate, and so is a `WORKAROUND` on a paused Problem (D-099).

**The review.** Four optional summaries become ordinary Events — `DISCOVERY`, `FIX`, `DEAD_END`, `HYPOTHESIS` — with `changed_by` as each `source_ai`. No Review resource and no new event type (D-100). Closing with nothing to add is fine. No `client_event_id` is asked for: `expected_version` already makes a resend conflict rather than duplicate.

**One act.** Status, fix kind, the Events and one change log entry commit together, in one transaction and one version step (D-101). Two rollback tests and four concurrency races cover it, each confirmed to fail against a deliberately broken implementation. The summaries stay out of the history; the Events are where that text lives.

**Two Event findings.** `appendEvent` no longer catches a unique violation — it uses `on conflict … do nothing returning`, because the old recovery aborted an enclosing transaction. And Events written in one transaction share a `created_at`, so the review Events have no order among themselves; left as is, deliberately (D-102).

## What exists now — Memory controls (P2-11)

| Method | Path |
| --- | --- |
| PATCH | `/v1/problems/:problem_id/memory-control` |

**What it is for.** Deciding how a Problem should be *used* as memory, rather than editing what it says. Basic modification is still `PATCH /v1/problems/:problem_id`, which continues to accept these fields and `freshness` — nothing was taken away to make room.

**Four independent axes.** `memory_read_enabled` (drawn on when memory is consulted automatically), `memory_write_enabled` (an assistant may add to it), `suppressed` (surface it less), and `freshness` via `invalidate`. No control implies another: turning off reads does not suppress, suppressing does not invalidate, invalidating disables nothing. Every integration test that sets one asserts the other three did not move.

**`invalidate: true` only.** Sets `freshness` to `INVALID` and nothing else — not status, not `fix_kind`, not confidence. `invalidate: false` is refused, because a Problem that became `INVALID` may have been `CURRENT`, `STALE_UNKNOWN` or `SUPERSEDED` before, and restoring a guess would overwrite a real distinction. The route refuses `freshness` directly for the same reason; revalidating goes through the ordinary update.

**Not authorisation.** Turning everything off leaves every read of the Problem working and the controls reachable, so nothing can be locked away by accident. Not enforced either: nothing retrieves memory automatically yet, and nothing can tell an owner's write from an assistant's, so no endpoint refuses on the strength of a flag.

**One mutation path.** `applyProblemMutation` is shared with the ordinary update: same version column, same compare-and-swap, same transaction, one change log entry however many controls moved. No migration, no new column, no new repository operation.

## What exists now — ChangeLog (P2-10)

| Method | Path |
| --- | --- |
| GET | `/v1/problems/:problem_id/change-logs` |

**Written by the service, never by a caller.** No POST, PATCH or DELETE, and no field of an entry comes from a request body. A history a caller can author is not a history. Not a trigger either: what may be recorded is a product decision.

**One transaction with the change.** Both mutating services run inside `runInTransaction`, and the entry is written there. A Problem edited with no record, or a record of an edit that did not happen, are both worse than the write failing. `src/db/transaction.ts` is the runner; `pg` stops there, and a service sees only an owner-scoped repository.

**One entry per mutation.** Five fields changed is one entry naming five fields. `from_version` and `to_version` bracket it, a CHECK requires them to differ by exactly one, and `(owner, problem, to_version)` is unique — the compare-and-swap already guarantees that, and the constraint states it.

**Refused changes record nothing.** Stale version, disallowed transition, missing evidence, nothing-to-change, another owner's problem. Throwing inside the transaction rolls it back.

**Controlled values exact, free text described.** `status`, `fix_kind`, `importance`, `confidence`, `freshness` and the flags keep their before and after. `title`, `symptoms`, `problem_domain`, `suspected_boundary` and `source_ai` record only presence and whether the value differed — a copy would outlive a later removal and defeat it.

**`changed_by` required on both write paths.** Free-form, recorded in the history rather than on the Problem, and never consulted for authorisation.

**Only Problem mutations.** Creating a Problem, appending an Event or Verification, linking a Relation and recording usage all leave the history untouched.

## What exists now — UsageLog API (P2-09)

| Method | Path |
| --- | --- |
| POST / GET | `/v1/problems/:problem_id/usage-logs` |

**What it records.** That a past Problem was used while working on another: `SEARCHED`, `REFERENCED`, `ADOPTED`, `EXCLUDED`, `CHANGED_STRATEGY`. `problem_id` is the problem being worked on, `memory_id` the past one drawn upon. `source_ai` and `reason` are required and non-blank; `result` is null when the outcome is not known yet.

**No order between the actions.** An adapter reports what it can tell, so nothing requires `SEARCHED` before `ADOPTED`. A required sequence would make this a workflow adapters had to satisfy with invented entries.

**Explicit only.** No read writes one — fetching a Problem or listing its Events, Verifications or Relations records nothing. A read that quietly writes can fail for reasons the caller never asked about, and only the adapter knows whether it *used* a memory or merely looked.

**`source_ai` describes, never authorises.** The owner comes from the request context. A test sends another AI's name, another owner's id and `root` in that field and asserts each reaches the same data.

**Cross-project yes, cross-owner no.** Both ends checked in the application and by a foreign key, with another owner's Problem indistinguishable from one that does not exist. A Problem may be its own memory — unlike a Relation — because continuing an investigation under a different AI is real.

**Changes nothing.** Neither Problem's status, version or `updated_at` moves, no confidence or freshness is copied, and no Relation, Event or Verification appears. Adopting a `VERIFIED` memory does not make the current Problem verified: memory is a candidate, not an answer.

**Not a global audit log.** No tool, model or approval columns and no audit route. That layer belongs above this service, and this table has to stay something it could read from.

**Create and list only.** The list is scoped to the problem being worked on. Retention and correction are deliberately undecided, and there is no idempotency key.

## What exists now — Relation API (P2-08)

| Method | Path |
| --- | --- |
| POST / GET | `/v1/problems/:problem_id/relations` |

**What a Relation is.** A link between two of one owner's Problems, with a meaning and a stated reason: `SIMILAR_TO`, `RELATED_TO`, `CAUSED_BY`, `SUPERSEDES`, `CONTRADICTS`, `DERIVED_FROM`. `reason` is required and non-blank, in the domain and in a CHECK.

**Cross-project, never cross-owner.** Two Problems in different projects may be linked — that is the point of it. Two owners' Problems may not, and refusing it reveals nothing: another owner's Problem answers exactly as one that does not exist. Both ends are checked in the application *and* by a foreign key.

**No self-links.** Refused in the application and by a CHECK, for any relation type.

**One row per link.** No mirror row for the three symmetric meanings. Listing a Problem's relations returns both ends — `from_id = ? or to_id = ?`, one index per side — and rows come back as stored, never flipped to suit whose list is being read.

**Not an inheritance.** Creating a link changes neither Problem: no status, no version, no `updated_at`, and nothing copied across. Evidence in particular does not travel — a Problem linked to a `VERIFIED` one still needs its own successful Verification, and a test drives exactly that. Because it is not a Problem write, there is no `expected_version`.

**Create and list only.** No single-relation read, update or delete, and no `updated_at` or `version` on the table. How a mistaken link is withdrawn is deliberately undecided.

## What exists now — Optimistic locking (P2-07)

**Every Problem write names a version.** `expected_version` is required on `PATCH /v1/problems/:problem_id` and on the status transition. An integer from 1, never coerced: `"4"`, `4.5`, `0`, `true` and null are 400. It is a token, not a field — `version` itself stays unwritable, and a body carrying only the token is refused because it changes nothing.

**Success moves it, refusal does not.** A successful write sets `version = version + 1` in the statement itself, never from a caller's value. Everything refused — an empty patch, a stale write, a disallowed transition, a missing successful Verification — leaves the record untouched, `updated_at` included.

**One lock, both paths.** The ordinary update and the status transition share the same column, so an edit and a transition conflict with each other. Two separate locks would let someone edit a Problem out from under a transition with neither noticing.

**The database decides.** The write is `update ... where owner_id = ? and problem_id = ? and version = ?`. The service compares versions too, but the predicate is what settles a race; a read-then-write leaves a window where both callers believe they won. Three integration tests race real requests — two patches, two transitions, a patch against a transition — and each was confirmed to fail against a read-then-write before being kept.

**`VERSION_CONFLICT`, 409.** A fifth error code, because a client acts on it differently: re-read and decide again. The message names no version — a client knows what it sent, and reporting the current one would describe a record rather than the request.

**Order of checks.** Ownership first, so another owner's Problem is a 404 whatever version is guessed. Then the version, then the transition rule: a caller working from a stale read has a stale idea of the status too, so the useful answer is "read it again" rather than a verdict on a move it might not have asked for.

**Appends are not versioned.** Events and Verifications carry no `expected_version`, do not check the Problem's version and do not move it. An append still succeeds after a Problem write was refused as stale — losing what was learned because the body of the record was contended would be the wrong trade. Their retry protection is `client_event_id`, which answers a different question.

## What exists now — Status transitions (P2-06)

| Method | Path |
| --- | --- |
| POST | `/v1/problems/:problem_id/status-transitions` |

**The only way status changes.** Body is `{ "target_status": ... }` and nothing else. The Problem PATCH still refuses `status`, no append moves it, and `updateProblem`'s input has no status field — the repository has a separate `updateProblemStatus` for this one path.

**The matrix.** `INVESTIGATING → FIX_CANDIDATE | PAUSED | CLOSED_UNRESOLVED`. `FIX_CANDIDATE → INVESTIGATING | VERIFIED | PAUSED | CLOSED_UNRESOLVED`. `PAUSED → INVESTIGATING | FIX_CANDIDATE | CLOSED_UNRESOLVED`. `VERIFIED` and `CLOSED_UNRESOLVED` lead nowhere. A status cannot move to itself.

**Where the rule lives.** `src/domain/problem-status.ts`, as data and pure functions — no HTTP, no storage, no repository. All 25 pairs are tested against a matrix written out independently of it, and the architecture test forbids a status literal anywhere in `src/` outside the domain, so no route or service can decide part of it.

**`VERIFIED` has to be earned.** Only from `FIX_CANDIDATE`, and only with at least one Verification *of this Problem's own* whose boolean `result` is true. A FIX event, a confident summary, a high confidence, another Problem's evidence and another owner's evidence all count for nothing. The replayed-verification case is covered explicitly: a retry aimed at a different Problem returns 201 with the original but records nothing here, and the transition is still refused.

**PAUSED resumes.** Back to either working status; it is not terminal. The two terminal statuses are ends for now — reopening raises questions about whether old evidence still holds, and nothing answers those yet.

**Status only.** `fix_kind`, `confidence`, `freshness`, `importance`, the memory flags and the text all stay put. A refusal writes nothing at all, `updated_at` included. The version moves on success, since P2-07 — see below.

**Refusals from the rule are 400.** Invalid enum, disallowed move, same status, terminal status, missing evidence — one code, one envelope. A stale `expected_version` is the separate 409 that P2-07 added, and is checked before the rule.

## What exists now — Verification API (P2-05)

| Method | Path |
| --- | --- |
| POST / GET | `/v1/problems/:problem_id/verifications` |

**Attached to the Problem, never to an Event.** No `event_id` in the request or the response, and no route reaching a Verification through an Event. A FIX Event says what was changed; a Verification says whether it worked. A Problem with a Verification and no Events at all is a coherent record, and a test keeps it one.

**`result` is a boolean, at the boundary too.** True means a check was carried out and confirmed the state, false that it was carried out and did not. "Not checked yet" is the *absence* of a Verification — so `null`, `"true"`, `"false"`, `1`, `0` and a missing field are each a 400 rather than coerced. A failed check is stored and listed like any other: it is evidence too.

**Retry replays, and cannot change the finding.** Idempotent on `(owner_id, client_event_id)` exactly as Events are. What is stronger here: a retry claiming the opposite `result` still returns the original unchanged, in both directions. A retry is the same write arriving again, not a second check. A different finding is a new Verification with a new key, and both stay visible.

**Ownership first, same race handling.** Both routes confirm the problem is the caller's before the key is consulted. The insert is attempted and the unique index decides; six simultaneous retries produce one row, and that test was confirmed to fail against a read-then-write append.

**Still decides nothing.** A successful Verification leaves `status` where it was, including `INVESTIGATING`. No transition service, no status write, no version increment. An integration test reads the status back through the API to check it.

**`DuplicateClientEventIdError` is gone.** With both append paths replaying, nothing raised it, so it was removed rather than kept for symmetry. The two `(owner_id, client_event_id)` unique constraints are untouched and still refuse a direct insert past the append path.

## What exists now

Read this to know what you are building on.

**Runtime.** TypeScript in strict mode, ESM with `NodeNext`, npm with a committed lockfile. `npm run check` runs typecheck, lint, format check and tests; `npm run build` compiles to `dist/`. See `docs/development.md` for commands.

**Database.** PostgreSQL, with Supabase CLI + Docker as the local environment. Twelve migrations under `supabase/migrations/`, replayable onto a clean database with `npm run db:reset`. Nine public tables: `owners`, `projects`, `environments`, `problems`, `events`, `verifications`, `relations`, `usage_logs`, `change_logs`.

**Value sets.** Eight closed sets — ProblemStatus, FixKind, EventType, VerificationType, RelationType, UsageAction, Confidence, Freshness — declared once in `src/domain/enums.ts` and enforced by text-backed PostgreSQL DOMAINs with CHECK constraints. No native enum types. A test drives every application value through the database and compares the constraint back, so the two cannot drift.

**Ownership.** `owner_id` is a UUID the Memory Server issues, never a vendor account id. Every table carries it, so owner scope needs no join. An `OwnerContext` comes only from `resolveOwnerContext`, which fails closed when the owner is missing, malformed or absent from the database.

**Relations.** Each level is checked against its parent as a composite key, so an Environment cannot belong to another owner's Project, a Problem cannot reference another Project's Environment, and an Event cannot attach to another owner's Problem. Reading someone else's record is indistinguishable from reading one that does not exist.

**Events and Verifications.** Both are append-only: no update path, no `updated_at`, no trigger. A Verification attaches to the Problem directly, never to an Event, and carries a boolean `result` so a successful verification can be found mechanically. `client_event_id` is required and unique per `(owner_id, client_event_id)` within each table, so a retried write cannot land twice.

**Deletes.** All ten foreign keys are `ON DELETE RESTRICT`, schema-wide. A parent with children cannot be removed. Deliberate removal still works from the leaves up; only implicit removal is prevented.

**Indexes.** One ordered index per list path — events and verifications by `(owner_id, problem_id, created_at, id)`, problems by `(owner_id, project_id, created_at, problem_id)` — plus the environment foreign key index. No index is a left prefix of another. Vector and full-text indexes belong to the retrieval phase.

**Storage boundary.** `MemoryRepository` in `src/repository/` is owner-scoped: the `OwnerContext` is fixed at creation and no method takes an owner argument. Twenty-three operations — create/get/list/update Project, create/get/list Environment, create/get/list/update Problem, transition Problem status, conclude Problem, append/list Event, append/list Verification, create/list Relation, create/list UsageLog, create/list ChangeLog. It is a thin facade over `src/db/`, writes no SQL, and does not reinterpret error codes.

**Executor.** `DatabaseExecutor` is `query` and nothing else. A pool satisfies it, and so does a client checked out for a transaction — which is what P2-10 needed, and it changed nothing below. `DatabaseTransactionRunner` in `src/db/transaction.ts` runs work as one transaction; the repository still does not own one.

**Layering.** domain ← service/API ← repository ← db ← PostgreSQL. `tests/architecture.test.ts` enforces it: the domain imports no driver, storage or vendor module and holds no SQL, and `pg` is named only in `db/config.ts`, `db/executor.ts` and `db/pool.ts`.

**Test.** `tests/integration/phase1.integration.test.ts` runs one problem from first suspicion to confirmed fix through the repository, plus the negative cases. 1702 tests across 58 files.

## What is deliberately absent

Do not assume these exist, and do not add them outside the phase that owns them.

- Nothing prevents `VERIFIED` at the database level. The rule is enforced by the transition service, which is the only path that writes status
- No way to reopen a `VERIFIED` or `CLOSED_UNRESOLVED` Problem, and no way to revise a conclusion or a `fix_kind` once one is recorded
- No delete anywhere, no Environment update, no Relation or UsageLog update or delete, no MCP, no ChangeLog, no sanitization, no search, embedding or retrieval, no AI adapter, no UI
- No pagination, filtering or search on list endpoints
- No OpenAPI generation. Response schemas exist per route and are reusable for P2-13, but nothing generates a document

## Immediate objective

P2-13 — API contract / schema documentation.

Not started.

Notes for whoever picks this up:
- Every route already declares request and response schemas, and they are what the server actually enforces. Whatever document is produced must not become a second source of truth that can drift from them
- Nothing generates a document today, and nothing depends on one existing. Whether it is generated from the schemas or written alongside them is the first decision
- The surface is now complete for Phase 2: health, `/v1/me`, Projects, Environments, Problems, Events, Verifications, transitions, Relations, UsageLogs, ChangeLogs, memory controls and close
- The error envelope and its five codes are part of the contract, as is the rule that another owner's resource answers exactly as one that does not exist. A document that describes 404 without saying why would lose the point of it
- `docs/development.md` already narrates the API in prose. Decide whether the new document replaces that section, references it, or sits beside it — three descriptions of one API is the failure mode

## Core MVP milestone

The Core MVP is not complete until the Phase 7 cross-project E2E succeeds: Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
