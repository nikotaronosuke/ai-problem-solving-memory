# CURRENT

Updated: 2026-08-16 (P4-01)

## Current phase

Implementation Phase 1 — Foundation / Repository / Database: **COMPLETE**

Implementation Phase 2 — Core Memory API: **COMPLETE** (P2-01 … P2-14)

Implementation Phase 3 — Privacy / Security / Reliability: **COMPLETE** (P3-01 … P3-12)

Implementation Phase 4 — Retrieval: **IN PROGRESS** (P4-01 done; P4-02 next)

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

**Errors.** One envelope everywhere: `{ error: { code, message }, request_id }`. Codes are `INVALID_REQUEST`, `UNAUTHENTICATED`, `NOT_FOUND`, `VERSION_CONFLICT`, `EXPORT_BLOCKED`, `INTERNAL_ERROR`. The two 409s differ in what a caller should do: re-read a Problem, or remove a record holding a credential. Fastify and Ajv error objects never reach a client, and an internal failure returns no stack, driver message or connection string.

**Auth.** Everything under `/v1` requires a credential. A `preHandler` on the `/v1` scope calls the request-context service, which verifies the presented credential and hands back an owner-scoped `MemoryRepository` — a handler never sees an owner id it could pass anywhere. Every distinct failure is one entry in the log and one indistinguishable 401 to the client, so the endpoint is not an existence oracle. Since P3-04 the credential is real; see *Credential separation* below.

**Not a credential.** An owner id supplied in a header or body authenticates nothing. `MEMORY_OWNER_ID` established the HTTP context until P3-04 and deliberately no longer can — it remains local tooling for bootstrap and for issuing credentials, with no route into a request.

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

## What exists now — The machine-readable contract (P2-13)

| Method | Path |
| --- | --- |
| GET | `/openapi.json` |

**Source of truth.** The route schemas, unchanged. `@fastify/swagger` in dynamic mode reads what Fastify already validates and serialises through, and assembles an OpenAPI 3.1 document from it. Nothing is hand-written and no generated artefact is committed, so there is no second description to keep in step (D-103, D-104).

**OpenAPI 3.1, not 3.0.** The runtime schemas are plain JSON Schema — `type: ['string','null']`, enums containing `null`, `enum: [true]`, `minProperties`. 3.1 adopts that wholesale; 3.0 would have meant rewriting live validation into its `nullable` dialect, which is a document format deciding what the server accepts (D-105). Verified: every one of those survives generation intact, including the `\S` non-blank pattern.

**Registration order.** The generator collects routes through an `onRoute` hook, and `register` is deferred — the hook does not exist until `ready()` runs the queue. A route added straight to the instance before then is missing from the document with nothing failing, which is what happened to `/health` while this was being written. Every route now goes through a queued plugin, and the inventory is asserted rather than trusted (D-106).

**`/openapi.json`.** Outside `/v1` and unauthenticated: the shape of the API is not anyone's memory, and a client that cannot read it cannot learn how to establish an owner. Hidden from its own output. No YAML, no owner-scoped copy, no UI (D-107, D-109).

**25 operations, stable names.** `healthCheck`, `getCurrentOwner`, and one per route. These are what a generated client calls its methods, so a rename is a breaking change to someone else's code (D-108). Eleven tags, classification only.

**Authentication, once it existed.** P2-13 declared no security scheme because none existed, and publishing `BearerAuth` would have generated clients sending a header nothing reads (D-110). P3-04 built one, and the same rule points the other way: the document declares exactly the `memoryToken` bearer scheme the server implements, requires it by default so a new route is documented as protected, and exempts only `/health`. `owner_id` is data, never a credential (D-135).

**Drift detection.** 70 tests read the generated document and assert against literal values: the exact operation inventory both ways, unique operationIds, every enum set, required fields, `minProperties`, `additionalProperties: false`, the five error codes, and parity between `app.swagger()` and the served response. A route schema loosened by accident fails there (D-111).

**Human semantics.** `docs/api-contract.md` — what a 404 means, how `expected_version` and `client_event_id` behave, what counts as evidence. No field list: that is the document's job.

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

**Test.** `tests/integration/phase1.integration.test.ts` runs one problem from first suspicion to confirmed fix through the repository, plus the negative cases. 2155 tests across 67 files.

## What exists now — Phase 2 end to end (P2-14)

`tests/e2e/phase2.e2e.test.ts`. 19 tests: 14 ordered steps of one scenario, then five refusals.

**Real all the way down.** HTTP through `inject()`, Fastify validation, the real application services, an owner-scoped repository, PostgreSQL. Nothing substituted — the app is composed exactly as `src/index.ts` composes it, and the only thing the test controls is where the owner comes from. Raw SQL appears in owner setup and teardown and nowhere in the story.

**Self-contained.** Two owners generated per run, never the developer's. Cleanup deletes only what those owners created, children first. It does not assume an empty database, and skips without `DATABASE_URL`.

**What it adds over the endpoint suites.** Continuity, which is the one thing they cannot check: the id one call returns is the id the next accepts, the version handed back is the version the next write must present, and state written early is still there, unchanged, twelve steps later. Nothing is hard-coded between steps.

**The scenario.** A sign-in callback failing only after deployment: project and environment, the problem started at INVESTIGATING/version 1, the five investigation events, FIX_CANDIDATE, a successful Verification that deliberately does not conclude anything, then VERIFIED with `ROOT_FIX` through the close route. Then a second project with a structurally similar problem, a cross-project `SIMILAR_TO` relation, a usage log recording the first as memory used, a memory control change, an ordinary edit, and a final re-read of everything from the database rather than from any earlier response.

**The refusals.** VERIFIED without a check of its own (a FIX event and a persuasive summary are not evidence), a write from a stale version, one owner reaching another's problem by read, by write and sideways through a relation, a resent append with a different payload, and a self-relation.

**Confirmed to discriminate.** Removing the Verification step makes VERIFIED unreachable in the real sequence and everything downstream fails — the scenario depends on the state it builds, not on assertions that would pass either way.

## What exists now — The sanitization boundary (P3-01)

`src/sanitization/`. No route, no table, no repository operation: this phase installs a checkpoint, not a feature.

**Where it is.** A service never builds a repository — it is handed one, and `app/request-context.ts` is the only place either the ordinary or the transactional repository is constructed. Both are wrapped there, so the boundary is on the path of every write that exists and every write that will exist. An adapter written later gets its context by the same route and inherits the same checkpoint; there is no second way in.

**Why a Proxy.** A hand-written wrapper listing twelve write methods goes stale the moment a thirteenth is added — it still compiles, still delegates, and silently stops covering it. Intercepting every call means a new operation is covered because nothing had to be updated for it to be. Reads are named; anything unnamed is treated as a write, so forgetting costs a redundant inspection rather than an unchecked write (D-112).

**Nested input, keys included.** Nothing is checked by field name. The traversal descends through objects and arrays to every string — every value, and every key naming one — with the path it was found at. Keys matter as much as values: an Environment snapshot stores whatever JSON was sent, so a caller can put text in a key as easily as in a value, and inspecting only values left a way around the boundary. Found in review after the first commit and fixed (D-113, D-116).

**It changes nothing.** The traversal rebuilds rather than mutates and preserves shape exactly: key order, array length, `null` as `null`, and keys whose value is `undefined` still present — absent and null are different instructions on a partial update. With the policy this phase ships, what goes in is what comes out, and all 1793 Phase 1/2 tests pass untouched.

**The policy decides nothing.** `createPermissivePolicy()` keeps every string. There is no pattern list, no threshold and no guess: detection is P3-02 and refusal or redaction is P3-03, and a provisional secret check shipped as production logic would be worse than an honest absence (D-114).

**A refusal carries nothing a policy wrote.** `SanitizationRejectedError` holds the locator and whether it was a key or a value. Both are written by the boundary. A `reject` outcome has no field for prose, a policy has no `name`, and the boundary reads only `kind` and `value` from an outcome — so there is nothing a policy could contribute even if it tried. This took three passes: the first version let a policy attach a free-text reason (D-117), and the second still put `policy.name` — free text fixed at configuration time — into every refusal and log line (D-119).

**Persistence-safe is not log-safe.** Two paths, deliberately. The internal `FieldPath` keeps raw caller keys, because detection needs the context — `snapshot.auth.token` is what tells a detector how to read the value under it. The external locator, the only form that reaches an error or a log, drops every key: `createEnvironment[0].<key>.<key>.<redacted>`. Keys are dropped whether or not the policy kept them, because a secret detector keeps an email address for being not-a-secret, which says nothing about whether it belongs in a log file. The second review found the earlier "approved keys are safe to name" reasoning and it was wrong (D-116, D-118).

Transport maps a refusal to the existing `INVALID_REQUEST`; no new error code, and unreachable with the current policy.

**Tested by breaking it.** Unwrapping the transactional repository, making the traversal shallow, and misclassifying one write as a read each fail multiple guards, including the architecture test that asserts every handout is wrapped and the one that asserts a refused close leaves nothing behind.

## What exists now — Secret detection (P3-02)

`src/sanitization/secrets/`. No route, no table, no repository operation, no new dependency: a detector and a policy, plugged into the boundary P3-01 built.

**Detection and action are separate files on purpose.** `detector.ts` says what a string is; `policy.ts` says what happens to it. P3-03 changes the second without reopening the first (D-120).

**Names carry their issuer.** `accesskey`, `secretkey` and `securitytoken` were exact names, so `AWS_SECRET_ACCESS_KEY` — which is how a real credential variable is written — matched nothing and read as ordinary prose. A review found it through P3-06: the export inspects with the same detector, so a Memory holding one was exported in full, reproduced at 200 with the secret in the body. Three compounds became suffixes instead, each judged against the same test the strong names state — no ordinary reading (D-150). `accesskey` deliberately stayed exact: HTML gives every element one, so as a suffix it would make `menuAccessKey` a credential, and the AWS half that is secret is `SECRET_ACCESS_KEY` anyway.

**Meaning, never shape — in both directions.** No entropy score and no length threshold as evidence *for* a secret: "long random string" describes a UUID, a commit SHA and every evidence reference in the system (D-122). And none as evidence *against* one either, which took a review round to get right: `PASSWORD=letmein` and `{"api_key":"abcdef"}` are credentials, and an earlier version stored them because the value read like a word (D-124).

**Names carry a strength.** `strong` names — `password`, `api_key`, `client_secret`, `access_token`, `private_key` — have no ordinary reading, so the value's shape is not consulted at all. `ambiguous` names — `token`, `secret`, `session` — do, so there shape separates `confirmed` from `suspected`. That is the only place it decides anything.

**Content is read, not measured.** One function used by every rule: a value is a `placeholder` (already redacted, or a template), a `status` word (`unknown`, `expired`, `rotated` — a note about a credential), or a `value`. So `Authorization: Bearer [REDACTED]` and `{"api_key":"[REDACTED]"}` get the same answer, and a caller never has to learn which rule saw their string.

**Headers are parsed.** `Authorization` needs a recognised scheme *and* a credential; `Authorization: disabled` and a bare `Authorization: Bearer` carry nothing. Cookies are split into pairs. One line is judged once — a header line is not re-read as a generic assignment (D-124).

**Context comes from the structured path.** `{"api_key": "9f2c..."}` is recognised because the nearest key is named `api_key`, which is what P3-01's raw `FieldPath` is for. The association survives an array — `{"api_keys": ["..."]}` — and does not carry past an unrelated field.

**Keys and values alike.** A credential written into an object key is a credential; the content rules do not care which it was.

**Six categories, two certainties.** `PRIVATE_KEY`, `JWT`, `AUTHORIZATION`, `COOKIE`, `CREDENTIAL_ASSIGNMENT`, `CREDENTIAL_FIELD`; `confirmed` and `suspected`. Named after how something was recognised rather than after a vendor, which keeps this from being a token dictionary that is stale the week it is written.

**A finding holds no part of what it found.** Category and certainty, both from closed sets. No matched text, no excerpt, no offset, no hash — `JSON.stringify` of a finding is two short identifiers (D-121).

**Confirmed is refused; suspected is kept.** Refusal is fail-closed holding P3-02's own completion condition, not the reject policy: P3-03 owns that. `suspected` — an *ambiguous* name over an ordinary word, like `{"session":"morning"}` — is kept, because refusing configuration templates and documentation examples would make the record unusable, and nothing about it is logged either (D-123, D-124).

**False positives are a requirement, not a courtesy.** UUIDs, commit SHAs, content hashes, evidence references, URLs, file paths, package versions, PUBLIC keys, redaction markers and prose containing the words token/password/secret are all kept, each with a fixture. The detector is also the default policy, so all 1904 pre-existing tests act as a false-positive corpus and pass unaltered.

**Nothing new escapes.** The refusal is P3-01's: a safe locator and a key/value kind. The category is not published, the policy still has no name, and a real detector now drives the leak tests rather than a hand-written stub. A direct scan of every column of every table confirms no marker reached storage.

## What exists now — Redaction (P3-03)

`src/sanitization/secrets/`, now four modules. No route, no table, no repository operation, no new dependency.

**Three components, one shared parser.** `patterns.ts` locates credentials and reports spans; `detector.ts` asks what a string *is* and throws the positions away; `redactor.ts` keeps the positions and replaces what they cover; `policy.ts` decides between storing the result and refusing. Detection and redaction reading the same rules is what stops them drifting — one recognising a form the other cannot handle would be silent in both directions (D-125).

**Spans never leave the directory.** An offset and a length are information about a secret. `SecretFinding` is still two closed identifiers, and an architecture test pins that spans appear in exactly three files.

**Partial redaction.** `"failed because API_KEY=abc123 was stale"` becomes `"failed because API_KEY=[REDACTED] was stale"`. The variable name survives, which is the part worth reading later. Every credential in a string goes, not the first — a `.env` paste holds several.

**Whole-value replacement under a credential-named field.** `{"api_key":"secret"}` → `{"api_key":"[REDACTED]"}`. There is nothing around it to preserve.

**Refusal where removal is not safe.** An unterminated PEM block has no knowable end, so it is refused rather than guessed at. A key is refused because a replacement can collide with a key already present and merge two fields silently (D-126).

**Fail-closed post-check.** Redacted text is shown to the detector again, and if a confirmed credential survived the write is refused anyway. Partial removal is the worst available outcome: a record that reads as sanitised, still holding a credential, with the caller told it succeeded (D-127).

**Idempotent.** The marker is itself a recognised placeholder, so redacted text run through again finds nothing. Records survive export, migration and retry unchanged.

**`Set-Cookie` attributes are not cookies.** `Path=/`, `Max-Age` and `SameSite` describe how a browser should treat a cookie. Only the first pair is the credential; an earlier version read `Path=/` as a second cookie value and refused the whole string.

**Two pre-sanitization log paths closed.** Ajv names the offending property on an `additionalProperties` failure, so logging the error object wrote a caller-chosen key into the operational log — before sanitization runs, since validation is first. Nothing from a validation error is logged now (D-128). The malformed-JSON branch got the same treatment defensively; Fastify 5 replaces the message and it was not observed to leak.

## What exists now — Credential separation (P3-04)

**Two tables.** `clients` belongs to an owner; `client_credentials` belongs to a client. A credential does not carry `owner_id`, deliberately: duplicating it would create a second answer to who owns a credential, and two answers can disagree (D-130). The owner is reached by joining, which is one answer by construction.

**The token.** `mem_<lookup>_<secret>`, opaque, saying nothing about who holds it. The lookup is 16 base64url characters from 12 random bytes and is a public selector; the secret is 43 characters from 32 random bytes. Only a SHA-256 digest of the secret is stored, compared in constant time (D-131). The raw token exists once, at issue, and is printed once — a lost token is replaced, never recovered.

**The lookup proves nothing.** It is stored in the clear, so anyone who has seen a token knows a valid one. A real lookup carrying a different well-formed secret is refused exactly like a lookup matching nothing, and a test presents precisely that: without the digest comparison the selector would silently *be* the credential.

**Five failures, one answer.** Missing, malformed, unknown, invalid and revoked are a closed enum for the log and one byte-identical 401 for the client. No part of a presented token reaches an error, a message, a stack or a log line — the rule P3-01 through P3-03 arrived at the hard way, applied to the most outside-influenced string there is.

**No environment fallback.** `MEMORY_OWNER_ID` established the HTTP context until P3-04 and now cannot (D-132). Thirty-eight test sites depended on it; they moved to an explicit double in `tests/support/` rather than leaving an optional fallback in production. A bypass kept for the convenience of tests is a bypass.

**Verified every request, cached nowhere.** No process cache, no connection cache, no map. Revocation takes effect on the next call rather than at the next restart (D-133).

**Rotation falls out of the shape.** A client may hold several credentials, so a second is issued, clients move over, and the first is revoked with no interruption. Revoking one credential leaves the client's others working.

**A separate store.** `CredentialRepository` is not part of `MemoryRepository` and is not owner-scoped — the lookup is what *decides* the owner, so there is nothing to scope to yet. It is also not wrapped by the sanitization boundary (D-134): pointing a secret detector at a digest is wasted work at best, and at worst a policy redacting the one column that must survive verbatim.

**Administered locally.** `npm run credential:issue -- --label "…"` and `npm run credential:revoke -- --credential-id …`. No HTTP endpoint, because an API that can mint its own credentials has to decide what may mint them. Revocation takes an id rather than a token, so revoking one does not put it in shell history.

**`clientId` on the context.** Carried, consulted by nothing. It is where a per-client permission decision will go, and the question an audit trail will ask.

**Two findings came from the mutation proofs, and both fixed a test.** Storing the secret's own bytes in place of a digest passed every credential test, because `to_jsonb` renders `bytea` as hex and no search for a base64url secret matches it; the test now decodes the column and compares against a digest computed from the standard library rather than from the function under test. And removing the `Authorization` redaction path changed nothing observable, because Fastify's `req` serializer never writes headers — dormant defence for the moment one does, pinned structurally, with the reason written down instead of a behavioural test that would pass either way.

## What exists now — Physical delete (P3-05)

| Method | Path |
| --- | --- |
| DELETE | `/v1/problems/{problem_id}?expected_version=N` |

**One unit: a Problem and everything referring to it.** The Problem, its events, verifications and change log, plus every relation and usage log naming it — including the ones pointing *in* from a Problem that survives (D-136). Not a search for a string: an operation that hunted for a secret would have to accept the secret as a parameter, which means sending a credential in order to remove one.

**Physical, not soft.** No `deleted_at`, no `DELETED` status, no tombstone, and no record that the Problem existed (D-137). A soft delete would need every read, list and append to remember to exclude the row, and the one that forgot would serve the content the delete existed to remove. With the row gone, every path already answers 404 — the same 404 as a Problem that never existed and one belonging to somebody else.

**Six statements, one transaction, leaves first.** `change_logs`, `events`, `verifications`, `usage_logs` (both foreign keys in one statement), `relations` (both ends in one statement), then `problems` with the version predicate. Every statement names the owner. The order lives in `src/db/problem-deletion.ts` and nowhere else, because it is a fact about the foreign key graph rather than a product decision.

**RESTRICT is the guard.** No cascade was added and none will be (D-139). If a later table references `problems` and is not added to the delete path, the final statement fails on the foreign key and the transaction rolls back: the omission is loud rather than silent. That failure is deliberately *not* reported as a version conflict — it is a programming mistake, and dressing it as a stale version would hide the bug behind a plausible retry.

**`expected_version` is required, and guards less than it looks.** It catches a change to the Problem — an edit, a transition, a conclusion. It does not catch an appended Event or Verification, because appending does not move the Problem's version (D-140). A delete decided at version 5 can remove an event that arrived afterwards. Stated plainly rather than implied, because requiring the token and describing it as protecting the aggregate would claim a guarantee the code does not give.

**The row lock does less than it appears to.** Correctness comes from the version predicate on the last statement, which holds with or without a lock. The lock adds determinism — a concurrent writer waits rather than causing five statements' work to roll back. A concurrent append is blocked either way, since deleting the Problem locks its row moments later, which is why removing the lock fails no behavioural test and is pinned by an architecture test.

**Nothing else in the request.** No `changed_by` (the history it would go into is being deleted), no owner or client id (they come from the credential), no confirmation flag. Any client that can send the delete can send `confirm: true`, so the flag would record that the client knew about the flag. Explicit user intent is the caller's responsibility — an adapter or the Phase 8 UI — and faking it at the server would make a real requirement look satisfied.

**204, with nothing in the body.** The deleted Problem is not echoed back: a caller removing a mis-saved credential should not receive it one more time in a response something may log. Deleting again is 404; a stale version is 409; another owner's Problem is 404 at every version.

**Project and Environment survive.** Deliberately, even when the deleted Problem was the last one using them (D-136). An Environment is a moment in time other Problems may name; a Project outlives the problems found in it. Clients and credentials are a different boundary entirely and no foreign key connects them to a Problem.

**Historical secrets, proved gone.** The acceptance test writes a credential marker into every free-text surface with raw SQL — simulating data written before the P3-02 boundary existed, since the boundary would refuse it today — then deletes through real HTTP and sweeps every Memory table with `to_jsonb`. The marker is asserted present first, so the sweep cannot pass by finding nothing. Another owner holding the same string keeps it, which is what makes this a Problem delete rather than a purge.

**A gap the mutations found.** Replacing `runInTransaction` with a direct repository call passed every integration test: in the successful case there is no observable difference, and the tests only looked at successful deletes. A service-level test now pins that the delete runs inside a transaction, and it is the only thing that fails on that mutation.

## What exists now — Export (P3-06)

| Method | Path |
| --- | --- |
| GET | `/v1/export` |

**Everything, in one document.** Eight collections — projects, environments, problems, events, verifications, relations, usage logs, change logs — with every column each table has, minus `owner_id`. That includes fields the rest of the API treats as read-only (`version`, `client_event_id`, the change log's version pair), because an export is the Memory rather than a view of the API (D-142).

**Format only. No importer.** §25.9 excludes import from the Core MVP completion condition, and the Phase 3 Definition of Done asks that an owner's Memory can be exported. Re-importability is *proved* rather than implemented: an artifact is handed back to PostgreSQL, unpacked with SQL, and the restored owner is exported again and compared collection by collection. Raw SQL on purpose — a TypeScript restore helper would become the unreviewed specification for the real importer.

**One owner id, at the top.** `source_owner_id` names the Memory the artifact came from; records carry none (D-144). It is not a credential and not an instruction: an owner id means nothing outside the install that issued it, and since P3-04 a request's owner comes from the credential. A restore chooses its own owner and writes it into the column.

**Every other identifier survives** (D-145), `client_event_id` included, so a restored Memory still refuses a resent Event rather than duplicating it. Restoring beside the rows an artifact came from collides on the primary key, which is the right answer: silent second copies under fresh ids would turn one Memory into two that drift.

**`schema_version` is `"1"` and is not the contract version** (D-143). P3-05 moved the contract 0.2.0 → 0.3.0 without changing the export by a byte; one number for both would have told every artifact holder to re-read their file.

**One statement, one snapshot** (D-146). The whole document is built by a single SQL statement, so it describes one moment by definition — no transaction, no isolation level to remember, no lock, and no writer blocked. Eight separate reads would take eight snapshots, and a delete landing between the third and fourth produces an artifact describing a state that never existed.

**Precision that JavaScript cannot hold.** Timestamps are formatted by PostgreSQL to six digits — a real stored `created_at` measured here ended `.015452`, and a JS `Date` would have written `.015`. Snapshots are embedded as JSON with their numbers intact, including ones past `Number.MAX_SAFE_INTEGER`. The document is fetched as text and the route sends those bytes with the compiled serialiser overridden: `JSON.parse` followed by `JSON.stringify` is not a round trip for this document, and the tests use the database's own text as the oracle so a broken export cannot agree with a broken expectation.

**A Memory holding a credential is refused, not redacted** (D-147). `409 EXPORT_BLOCKED`, its own code rather than a borrowed 409 — a client reading `VERSION_CONFLICT` would look for a version to re-read. Redacting would make the artifact differ from the database and stop being a copy; exporting anyway would put a credential in the largest file this system produces. Only *confirmed* blocks; suspicion keeps, as at the write boundary. The response says something is there and nothing about where.

**Exporting changes nothing** (D-148). No redaction written back, no invalidation, no flag, no deletion — asserted against the database before and after a refusal, and pinned by an architecture test that the export module contains no write of any kind.

**Credentials are not in it** (D-149). No token, lookup, digest, client id, label or revocation state, and the module does not read those tables. An artifact carrying one would be a backup file that is also a key.

**What the mutation proofs turned up.** A request body is parsed by `JSON.parse` before the server sees it, so a number too large for JavaScript cannot be *stored* through the API at all — the export is lossless with respect to what the database holds, which is the strongest claim available.

**And one security blocker, found by review and since fixed.** `AWS_SECRET_ACCESS_KEY=…` was not detected as a credential, so an export carried it out in full — reproduced at 200 with the raw secret in the response before anything was changed. The cause was in the P3-02 vocabulary rather than in the export, and the correction is there (D-150). Five export tests now hold the egress: removing the correction returns them to 200 with the secret in the body.

## What exists now — Retry queue (P3-07)

**Not part of the server.** `src/reliability/` is a client-side library, imported by nothing the server runs — not `src/http`, not `src/app`, not `src/db`, not the entry point — and an architecture test fails if that changes (D-151). The reason is E2E-7: the failure the queue exists for is *the Memory Server being down*, and a queue behind an unreachable server never receives the request it was meant to hold. Something the server starts cannot be the thing that keeps working when the server stops.

**Why it is in this repository anyway.** The adapters that will use it are Phase 5 and Phase 6, so shipping it with them means writing it twice; and what it encodes — which writes the server deduplicates, what it says when it refuses one, what a credential may never be written into — is this project's knowledge. The task list placing it in Step 3, before any adapter exists, is a real tension and is recorded rather than reinterpreted.

**Two operations, and only two.** `appendEvent` and `appendVerification` (D-152). They are the complete set of writes carrying `client_event_id`, where the database keeps the first write — so resending one leaves one row. Creating a Problem twice makes two Problems; an update carries a version a retry has already left behind; delete must never appear on this list. The union is closed and pinned by a test.

**The key is assigned once and never regenerated** (D-153). `clientEventId` sits at the top level, not in the payload, and survives the queue, a restart and every attempt. A queue minting a fresh key per attempt would produce exactly the duplicate the key prevents. Where the key comes from — generate, send, queue, replay as one path — is P3-08.

**Sanitized before it touches the disk** (D-154), with the server's own policy rather than a second idea of what a credential looks like. A queue file outlives the process, sits in a directory somebody chose, gets copied by whatever backs it up, and is read in a text editor when things have gone wrong. Confirmed credentials are redacted where safe and refuse the enqueue where not. There is no generic blob API, so a raw conversation or log dump cannot be handed to it.

**One file per item, replaced by rename** (D-155). Not PostgreSQL — same failure domain as the thing being worked around. Not memory — a restart would lose the Events. Not SQLite — a native module for a handful of small records. Written to a temporary file, flushed, renamed; the data is synced before the rename and the directory entry is not, which is stated in the module rather than implied. Names come from a generated UUID, so no path contains anything a caller supplied. The directory is a required option with no default: choosing it means choosing where somebody's unsaved work lives.

**Nothing is discarded but a success** (D-156). A delivered item is unlinked; a permanent refusal and an exhausted retry both become terminal and are kept, because P3-09 cannot report what has been deleted. A full queue refuses the new item rather than evicting the oldest — the oldest has been waiting longest to be saved. No TTL, no dead-letter subsystem, no endpoint, no UI. Every limit is the caller's to set.

**No credential, ever** (D-157). The stored shape is eleven fields, asserted whole rather than spot-checked. Delivery holds its own credential, so the queue never sees one. A consequence worth having: a credential rotated after an item was queued still delivers it. A `401` spends no attempt, changes nothing, and stops the drain until the caller has a working one. `owner_id` is recorded as a guard — a mismatch delivers nothing and changes nothing — and is not authorisation, which the server still decides from the credential.

**No timer** (D-158). `drain` takes the moment as an argument, so a ten-minute backoff is tested by passing a later date. This is the first clock the codebase has needed and it is supplied rather than read: `src/` still contains no `Date.now`, no `setTimeout`, no scheduler. Backoff doubles from a base, caps, and has no jitter; a `Retry-After` is honoured when it asks for longer and ignored when it asks for less.

**Classification reads a closed outcome, never a message.** Transport failure and `408/429/500/502/503/504` are retryable, `401` is its own answer, everything else refuses. `500` is the ambiguous one — this server answers it for a database that is briefly gone *and* for a bug — and it retries, because bounded waste on a bug is cheaper than discarding a write whenever the database blinks.

**A deleted Problem stops the item and resurrects nothing** (D-159). `404` is permanent, the item is kept terminal, the `problem_id` is untouched and no Problem is invented to hold the orphaned Event.

**Delivery is an interface and nothing else.** No HTTP client ships, because choosing a transport, a timeout and a credential source for adapters that do not exist is how a library acquires behaviour nobody picked. The integration test writes one, against a real server on a real port that is really stopped.

## What exists now — Idempotent replay (P3-08)

**Durable before attempted** (D-161). `submitEvent` and `submitVerification` enqueue the write and only then try to send it. The reverse order — send, and queue if that fails — is cheaper and has a window that loses data: the attempt fails, the process ends before the failure is written down, and the Event is gone with no trace. After `enqueue` returns, every outcome leaves either a queue item or a row on the server.

**No fallback to sending when the queue refuses** (D-162). Full, erroring, or holding a credential that cannot be removed — nothing is sent. The fallback looks like resilience and reintroduces exactly the window above, at the moment the system is least able to track what happened. Two tests assert the delivery is never called, so adding it later fails them.

**Three layers, one key** (D-163). The coordinator assigns `client_event_id`, once, before the write is durable; the queue persists it and never changes it; the server refuses the second write carrying it. The caller cannot supply a key, which is what stops two adapters each inventing their own discipline and one of them regenerating on retry. An architecture test pins that `generateClientEventId` is called in exactly one file.

**The first attempt carries the sanitized write** (D-164). `enqueue` returns the item it stored, and that item is what is delivered. Building a request from the caller's original would put an unredacted credential on the wire on the first attempt only — once is once too many, and it is the attempt least likely to be inspected.

**A first attempt is a retry** (D-165). `RetryQueue.attempt(queueItemId, …)` processes one item through the same two stages `drain` uses — whether the item may be attempted at all, then the attempt — so the eligibility gate, the owner guard, the classification, the backoff and the terminal states exist once. A review caught `attempt` skipping the first stage, which let an item id resend a permanently refused write or ignore a running backoff (D-170); it now answers `NOT_DUE`, `TERMINAL` or `NOT_FOUND` without delivering. The coordinator contains no retry logic and never names `classifyDeliveryOutcome` or `nextDelayMs`. `attempt` rather than `drain`, so recording one Event does not mean flushing the backlog.

**At least once, observably once** (D-166). No lock: two processes over one directory can both post the same item, and a crash between a success and the `unlink` replays a write the server already has. What makes that safe is the Phase 1 unique index on `(owner_id, client_event_id)` with the first write kept. "Exactly once" is avoided as a phrase — deliveries are not, and the **effect on Memory** is.

**The proof is a lost answer, not a stopped server** (D-167). The end-to-end tests post to a running server, wait for a real 201, and report a transport failure anyway. Against a stopped server the same tests would pass with a fresh key per retry, which is the bug this exists to prevent. Both Events and Verifications are proved this way; they take different insert paths on the server.

**Five mechanical outcomes** (D-169, D-183): `DELIVERED`, `QUEUED`, `AUTH_REQUIRED`, `PERMANENT_FAILURE`, `UNKNOWN`, plus the key. No body, no error, no credential. `RETRY_EXHAUSTED` and a refusal collapse into one, since neither will be retried and both stay on disk. Nothing is phrased for a person — that is P3-09's, and it now has something mechanical to be written against.

**Nothing on the server changed.** The unique index, `on conflict do nothing`, the re-read and the 201 with the original record have all been there since Phase 1. One measured caveat is recorded rather than fixed (D-168): a unique violation aborts its transaction, so `appendVerification` — which catches the violation instead of avoiding it — would break if it were ever called inside one. Nothing does, and a replay is an ordinary HTTP append.

## What exists now — Failure fallback contract (P3-09)

**A contract, not an engine.** `src/reliability/fallback.ts` turns what already happened — a submit outcome, a queue that refused a write, a search reporting itself unavailable — into a decision the caller acts on. No search engine, no adapter, no HTTP client, no notification renderer, and no scheduler were added.

**Named failures are absorbed; everything else throws** (D-171). The absorbed set is written out one member at a time: a submit outcome, `QueueCapacityError`, `SanitizationRejectedError`, `QueueStorageError`, `UNAVAILABLE`. An owner mismatch, a delivery that threw where its contract says to return, and any unrecognised error propagate untouched. `catch (error) { carryOn() }` would satisfy the requirement and turn every bug in the codebase into silence, so an architecture test counts the catches against the re-throws and behaviour tests drive each bug class through.

**`continueMainWork` is typed `true`.** There is no Memory failure that stops the work, so there is no branch — adding one means changing a type on purpose rather than writing a plausible `if`.

**A filesystem failure means different things at different moments** (D-181). `enqueue` is the admission boundary: a failure there is a write that was never taken, and stays `UNSAVED`. After it, the queue decides by what happened — a file that could not be removed once the server had accepted the write is `SAVED`, and anything else is `PENDING` with the item untouched. A review found all of them reported as `UNSAVED`, which told somebody their work was lost while it sat on the server.

**The kind of write and its importance are stated once each** (D-182). `submitEventWithFallback` and `submitVerificationWithFallback` take the caller's own input; the operation comes from which function was called. Passing either separately made an important Event describable as routine, which produces no notice at all — a mistake that type-checks and shows up only as something a person was never told.

**Filesystem detail stops at the queue's edge** (D-172). Each `fs` call is wrapped individually into a `QueueStorageError` carrying one of three operation kinds and nothing else: no path, no `errno`, no syscall, no OS message, and no `cause`. A Node filesystem error's message *is* the absolute path it failed on. Per-syscall rather than per-method, so only the filesystem can produce one; `ENOENT` on read and remove stay the "not a failure" answers they were.

**The Problem's importance is the only importance** (D-173). `submitEvent` and `submitVerification` take `problemImportant`, required and undefaulted — a default is wrong both ways, since `false` silences notices somebody asked for and `true` invents ones they did not. No importance was invented for Events, and none derived from event type: the spec gives importance to a Problem and to nothing else.

**Importance is a snapshot, kept on disk** (D-174, D-175). It is recorded when the write is made and never re-read, because the moment a queued write finally runs out of attempts is usually a moment the server is unreachable — that is why it ran out. A fallback contract that needs the Memory to be reachable is not one. The field made the queue format version `'2'`; leaving it at `'1'` would mean a reader could not tell "not important" from "written before the field existed". Three version numbers now coexist without sharing a constant: API `0.4.0`, export `"1"`, queue `"2"`.

**A write that cannot be found is not one that was lost** (D-183). An item missing from the queue is most often one another instance delivered and cleaned up — supported concurrency, and a write that is safely stored. It answers `UNKNOWN`, which claims nothing: not saved, not unsaved, not pending, and no notice even for an important Problem. `UNSAVED` is reserved for the settled case, and unrecognised outcomes fall to `UNKNOWN` too.

**A queued write is not a failure to report** (D-176). `DELIVERED` → `SAVED`. `QUEUED` and `AUTH_REQUIRED` → `PENDING`, silent even for an important Problem: there is a durable copy, it will be retried, and announcing it would interrupt somebody every time a laptop lost its network with news retracted a minute later. Only a permanent refusal, an exhausted retry, or a write the queue would not take produce a notice.

**One notice kind, carrying nothing about the write** (D-177). `IMPORTANT_MEMORY_UNSAVED`, with the operation and an opaque handle. No cause breakdown — to the person it all means the same thing, and every distinction added here describes internals nobody asked about. No summary, no reason, no Problem id, no path, no error message; in the case that matters most the write was refused precisely because its content should not travel. No sentences either: an architecture test caps every string literal in the module at the length of the notice kind.

**The same unsaved write stays recognisable** (D-178). `dedupKey` is the operation and the idempotency key — the logical write, not the file — so the notice given the instant it fails and the one found on disk a week later are identical. This module stores no acknowledgement; when somebody has been told enough is interface behaviour. `collectImportantUnsavedNotices` is what P3-07's refusal to delete a failed item was for, and answers `UNAVAILABLE` rather than guessing when the queue cannot be read.

**A search that did not run is not one that found nothing** (D-179). Empty is `AVAILABLE([])`; unavailable sends the caller to ordinary investigation, silently. Collapsing the two would have an assistant conclude a problem is novel because a database was briefly away. `fallbackForSearch` reads an attempt rather than wrapping a function, so a future engine's bugs are not absorbed along with its outages.

**The library answers; the caller works** (D-180). No `withMemoryFallback(mainWork, …)`. Continuation is proved by a caller-side sentinel, which is also what an adapter will look like.

## What exists now — Logging policy (P3-10)

**The log carries what the server decided, never what anybody sent it** (D-184). The previous configuration was safe by subtraction — Fastify wrote what it wrote, and a redaction list removed what somebody had thought of. Measuring it found five leaks, none of them on any list: the raw URL, so a credential in a 404 path or a query string was written verbatim; the caller-chosen `Host` header; the remote address and port; the driver's message behind a failed health probe, which named a database host, a port and an account; and every `Error` handed to the logger. The direction is now inverted, and adding a field is an edit to `createLoggerOptions` or to one of eleven call sites.

**Fastify's lifecycle logging stays; its serializers do not** (D-185). `req` becomes `{ method, route, operation }` — the route template or `UNMATCHED`, and the OpenAPI `operationId` or `null`. `res` becomes `{ statusCode }`. `err` becomes `{ failure: 'UNEXPECTED' }` from a function that takes no argument at all. No URL, no host, no headers, no address, no port, no body, no payload. `disableRequestLogging` was rejected: it is deprecated in Fastify 5.11.3, and its supported replacement is a *server* option, which would move the policy out of the one function every leak test runs as production configuration.

**No error reaches the logger, and none could say anything if it did** (D-186). Pino expands an `Error` into its message, its stack, its `cause` — appended into the message too — and every enumerable property. A `pg` unique or check violation carries the offending row in `detail`, which for this schema is Memory prose, plus `table`, `column`, `constraint`, `internalQuery` and `where`; a Node filesystem error carries the absolute `path`. Both the sink and the serializer are closed, and the mutation results say why: handing the error back with the serializer in place leaks nothing, removing the serializer with no call site passing an error leaks nothing, removing both leaks everything.

**A failed health probe reports a reason, not the driver's words** (D-187). `CONNECTION_FAILED`, `AUTHENTICATION_FAILED`, `UNEXPECTED_PROBE_RESULT`, `UNKNOWN` — classified from `error.code`, never from message text, and falling to `UNKNOWN` rather than guessing. The HTTP contract is unchanged: `200 {status:'ok'}`, `503 {status:'unavailable'}`, reason never in the response. This is the leak a serializer cannot close, which is why the two halves of the policy both exist.

**Eleven closed events, and a field allowlist** (D-184). `REQUEST_VALIDATION_FAILED`, `REQUEST_PARSE_FAILED`, `REQUEST_APPLICATION_REJECTED`, `SANITIZATION_REJECTED`, `AUTH_CONTEXT_UNAVAILABLE`, `EXPORT_BLOCKED`, `HEALTH_UNAVAILABLE`, `UNHANDLED_REQUEST_FAILURE`, `SERVER_SHUTDOWN`, `SERVER_SHUTDOWN_FAILURE`, `SERVER_START_FAILURE`. The permitted fields are `event`, `failure`, `validationContext`, `validationProblemCount`, `statusCode`, `locator`, `kind`, `reason`, `healthReason`, `latencyMs`, `signal` — all server-produced, none able to hold caller text, driver output or Memory content.

**`request_id` is the only identifier** (D-188). Fastify generates it and a caller cannot supply one — `requestIdHeader` defaults to `false` in Fastify 5, verified at runtime rather than read from documentation. No owner, client, credential, project, problem, event, verification or client-event id is logged, and neither is the remote address. The test applied was necessity, not secrecy.

**A server that cannot start says only that** (D-189). Configuration is read and the pool opened before a logger exists, so a failure there was an uncaught exception with a stack — and `EnvValidationError` quotes the offending value while `UnsafeDatabaseTargetError` quotes the database host. Startup now runs inside `main()`, whose caller prints one fixed sentence and sets a non-zero exit code. Proved by running the real entrypoint in a child process, because there is no call site a source guard could look for.

**An administrative command is not a monitoring log** (D-190). `credential:issue` still prints a token once; that is the command's result, not an accumulating record. The server process is held to one line, the static startup summary, which stays on `console.log` because moving it to Pino would not close the pre-logger path and would mean it could not print before the logger exists. `db:check` changed: it printed the driver's message and now prints the closed reason.

**Nothing new logs** (D-191). The logger is written from two modules — the transport boundary and the composition root. `src/reliability/` stays logger-free and `QueueStorageError` keeps its three operation kinds and no `cause`. UsageLog and ChangeLog stay Memory data: not mirrored into the process log, and not written to from it.

**Two layers of test, because either alone passes for the wrong reason.** An exact JSON field inventory fails the moment a field appears, whatever is in it; an adversarial sweep of twenty markers — credentials, JWTs, an AWS secret, a private key, a password-bearing database URL, an email, Memory prose, prompt, chain-of-thought and conversation markers, a filesystem path, a caller-invented key — fails when a permitted field starts carrying something it should not. Both run against `createLoggerOptions('trace')`, which is more verbose than any level `LOG_LEVELS` allows an operator to select.

## What exists now — Security tests (P3-11)

**Nothing in `src/` changed** (D-192). P3-11 is a regression proof over the boundaries P3-01 through P3-10 built, not a new mechanism. The investigation attacked the running system first — 21 cross-owner operations, six credential shapes, both two-ended writes, a dedup key replayed against another owner's Problem, sixteen malformed classes, all against a real database and a real credential — and found no production defect.

Two files were added and one extended. Detailed suites that already prove a category at a real boundary are **cited rather than copied** (D-193), because a second copy adds assertions without adding claims and gives them somewhere to drift.

### The five categories, and what proves each

**SECRET** — plaintext does not reach storage or any egress.
`tests/sanitization/secret-boundary.integration.test.ts` attacks the boundary over HTTP and sweeps the database, every response body and the operational log from the same fixtures, including the transactional close path. `secret-detector` / `secret-policy` / `secret-redactor` / `sanitizing-repository` cover the rules and the wrapper. `tests/reliability/retry-queue.test.ts` proves a credential is redacted before a queue file is written and that a payload which cannot be redacted gets no file at all. `tests/http/logging.test.ts` and `tests/export/memory-export.integration.test.ts` close the log and export sides. The false-positive half is evidence too: a suspected value is kept and prose about credentials is kept, so a security suite cannot drift into "refuse anything suspicious".

**OWNER** — cross-owner read and write are impossible, and owner-wide surfaces mix nobody in.
`tests/security/owner-boundary.security.integration.test.ts` is new. The resource suites, `tests/credentials/authentication.integration.test.ts` and `tests/export/memory-export.integration.test.ts` remain the depth behind it.

**DELETE_RESIDUAL** — after a physical delete nothing of the aggregate is still reachable.
`tests/delete/physical-delete.integration.test.ts`, now with a clean-marker proof (D-196) beside the historical-secret one. `tests/db/integrity.integration.test.ts` pins the seven incoming foreign keys, which is what makes "no derived search data" a structural fact rather than a fake table. `tests/reliability/server-down.integration.test.ts` proves a queued write does not resurrect a deleted Problem.

**RETRY_DUPLICATE** — a replay or a race leaves one observable row.
`tests/reliability/idempotent-replay.integration.test.ts` and `server-down.integration.test.ts`, with the Event and Verification route suites and the architecture guard on key generation. Unchanged by P3-11.

**MALFORMED_INPUT** — a controlled refusal, no mutation, no leak.
`tests/security/malformed-input.security.integration.test.ts` is new. `tests/http/openapi.test.ts` carries route and schema breadth; `tests/http/logging.test.ts` carries the log side.

### What the two new suites actually assert

**The owner-scoped operation set is classified exhaustively** (D-194). The suite reads the generated OpenAPI document at runtime, splits operations by whether they opt out of the document's security requirement, and asserts the owner-scoped half is exactly the twenty-six classified in the file — `healthCheck` being the one public operation. An operation added without a decision about its owner boundary fails here.

Twenty-two of them take another owner's identifier and are attacked with one, in a table whose own coverage is checked against the classification. Their refusals are compared to **each other** and required to be identical, which says more than each being 404 alone: a caller cannot tell which attack touched something real. Alice's rows are fingerprinted before and after the whole table and must be byte-identical. The remaining four take no identifier and are checked for what can go wrong with them instead — the export is asserted to hold none of the other owner's ids or text and nothing from the credential boundary, while still being a real export of its own owner's memory.

Also here: a version guard never answers what ownership refused, at any version; an idempotency key already spent cannot reach another owner's Problem and cannot be used to ask whether an id is real; one key can be spent by two owners; and linking across projects still works, because refusing across owners must not have quietly become refusing across projects.

**Malformed input is tested by schema class, not by route** (D-195). Fifteen classes, one representative attack each. Every attack must leave the database byte-identical, answer in the shared envelope and nothing else, echo no fragment of what was sent, name no Ajv internal, and put none of it in the operational log — swept with the production `createLoggerOptions`, stream replaced and nothing else. A bad identifier in a path is logged as `/v1/problems/:problem_id`, which is the 400-path counterpart to P3-10's 404-path proof.

### Two behaviours deliberately left alone (D-197)

An unknown query parameter is ignored while an unknown body property is refused. Nothing reaches storage or the log either way, so it is recorded as a contract asymmetry rather than fixed under a security heading.

Schema validation runs before authentication. Measured, not assumed, and not promoted into an invariant: no handler runs, nothing is written, and the contract document is deliberately public. Freezing a framework's lifecycle order as though it were a guarantee would be the wrong thing to protect.

**No manifest test** (D-198). What is checked is behaviour, in the two places a list can go stale silently — the runtime operation inventory and the malformed class table. A test asserting that a file exists proves something about filing, not about the system.

## What exists now — Phase 3 end to end (P3-12)

**Nothing in `src/` changed** (D-199). `tests/e2e/phase3.e2e.test.ts` carries one secret-bearing investigation through everything Phase 3 built, on one owner, one credential, one Problem, one queue directory and one server lifecycle — fifteen numbered steps, explicitly sequential, all real: PostgreSQL, an issued credential, the production composition, the production logger configuration with only its stream replaced, an ephemeral-port socket, an actual connection failure, a filesystem queue in a temp directory, and a retry that runs at the moment the persisted schedule names rather than after a sleep.

**Two secret Events, deliberately** (D-200). The queue redacts before anything reaches its disk — and therefore before any delivery — so an outage write can never present a raw secret to the server. Event A goes straight at the running server with the secret raw and is the server-side sanitization proof: stored and answered as `AWS_SECRET_ACCESS_KEY=[REDACTED]` with its sentence intact, the raw value nowhere. Event B carries a different secret through a real outage and proves the queue's own boundary on the way through: schema `"2"`, `problem_important: true`, the coordinator's key, the redacted sentence, and no credential in the file — checked as a boolean so a failure prints `true`, never the token.

**The continuity is the claim.** The version the importance PATCH answers is the version the DELETE presents, read back and confirmed unchanged first. The key found in the queue file during the outage is the key counted in the database after recovery: exactly one row for it, exactly one for Event A's, never a bare total. The fallback answers `PENDING` / `continueMainWork` / no notice for a Problem that really is important, with the caller's sentinel outside the library. The delete removes the aggregate and both redacted sentences while the survivor — same project, same environment, its own control marker — stays. The export that follows holds the survivor and none of the target: not its id, its markers, its Events' keys, or either secret. The whole stream of the production logger, across both server instances, holds neither secret, neither Memory marker, and not the credential; so does every response body any step read.

**"Deleted including search derivatives" is claimed honestly** (D-201). Phase 3 builds no search and P3-12 builds no fake one. The claim's true form today: the persisted aggregate is physically gone, and the catalog holds no relation a derivative could live in — zero views, materialized views, foreign tables or partitioned tables in the public schema, beside the exact eleven regular tables. This corrects the FK-inventory explanation from P3-11's report: a foreign-key inventory proves that everything *referencing* problems is known, not that no derived store exists. The guard is a Phase 3 boundary, not an architecture rule — P4-01 and P4-09 are expected to fail it, and the change that does must extend the delete path, the delete tests and the guard in the same change set (D-202). Its reach is PostgreSQL: the absence of external or in-process derived stores rests on the dependency count and the absence of any search module, and is not claimed as a catalog proof.

**Eleven discrimination mutations, each killed by a named step** (D-203): the sanitizer keeping a confirmed secret (step 4), the queue writing raw (step 7), the server never stopping (step 5), a queued write reported unsaved (step 6), a key regenerated on read (step 10), server dedup removed (`idempotent-replay`), a delivered item left in the queue (step 10), events surviving the delete (step 11), the problem row surviving (step 11), the export emptied (step 13), and a real view planted in the schema (step 12, named in the failure).

## Post-Phase-3 hardening — nested credential assignments (audit finding F1)

The independent final audit passed Phase 3 with one LOW finding, now closed. `x=AWS_SECRET_ACCESS_KEY=<value>` was read as ordinary prose — not detected, not redacted, stored as written — and it was wider than first reported: `ran x=AWS_SECRET_ACCESS_KEY=<value> then failed` missed too (D-204).

**Two mechanisms, not one.** A name needed two characters, so `x=` formed no assignment, and the inner name could not begin one because `=` is not a boundary. Separately, with a longer outer name the assignment did form and `\S+` swallowed the inner one, which `matchAll` then never revisited. Adding `=` to the boundary class fixes only the first — and corrupts quoted values — so it was prototyped and rejected on evidence.

**The walk is a cursor, with no depth limit** (D-205). Recursion overflows the stack on 10KB of nested input, and a depth cap would replace one blind spot with a smaller one. Termination is structural: each step advances past a name and a separator, so no offset is revisited. The first working version was quadratic (64KB took 1.7s); reading only `NAME=` and taking the value's end from the caller made it linear — 64KB now ≈50ms, 256KB ≈160ms.

**One parser, unchanged false-positive contract** (D-206). The fix is in `findAssignmentValues`, which the detector and redactor share. Nested values are judged by the same `certaintyFor`, so `x=token=expired`, `x=API_KEY=CHANGE_ME` and `x=API_KEY=[REDACTED]` are still kept. A strong outer name still claims its whole value, and a header with its own parser is still judged once — walking into `Set-Cookie: session=<token>; HttpOnly` misreads it, which is a regression that appeared during this work and is why the walk stops there.

**Export now refuses a Memory holding one** (D-207). Export inspects with the same detector and refuses rather than redacts, so a row stored before this fix exports today as `409 EXPORT_BLOCKED` until the owner deletes it. Safe direction, existing contract, recorded because an owner meets it as a failure.

Six mutations each killed by a named test: the walk removed, the two-character name restored, the span shifted one character, the quote bound dropped, status words counted as credentials, and the walk made recursive again (which fails with `RangeError` on the deep-nesting test).

Phase 3 remains **COMPLETE** and P4-01 remains **NOT STARTED** (D-208).

## What exists now — RetrievalArtifact (P4-01)

The first derived persistent store: `public.retrieval_artifacts`, a rendering of a Problem built so a search can find it. Storage and its rules only — nothing generates one, nothing reads one over HTTP, and nothing searches. The twelfth table, and the first extension this schema requires.

**One current artifact per Problem, or none** (D-209). No artifact id, no history, no version. A regeneration replaces; it does not add. Absent is an ordinary state that every Problem starts in, and the whole store is rebuildable from the Memory — losing all of it costs the time to regenerate and nothing else.

**Identified by owner and Problem together** (D-210). Primary key `(owner_id, problem_id)`, foreign key naming both columns against `problems (owner_id, problem_id)` with `on delete restrict`. `problem_id` alone would have been unique; the composite is used so the *database* refuses an artifact whose owner and Problem disagree, rather than trusting the code that scopes the read.

**pgvector, with no declared dimension** (D-211). The column is `vector`, not `real[]`: an array of floats has no distance operator and no path to one without rewriting the column and every row. No dimension is declared, verified before the migration was written — 3- and 5-dimension rows coexisted in a probe that was rolled back — because the model is not chosen yet and `vector(1536)` would make the first model's dimension a schema fact. The cost is stated: an untyped `vector` cannot carry an ANN index. There is no index and no search that needs one; the task that picks the model can fix the dimension then.

**`source_fingerprint` is opaque, `generated_at` is not evidence** (D-212). The artifact records the source state it was built from; this module stores that string and compares it for equality, and computes nothing — reading the Problem, its Events and its Verifications is the generator's work. `generated_at` is deliberately not a freshness test: a generation that read the source, then took a second while an Event was appended, timestamps an earlier state later. So the upsert is unconditional and a test asserts an *earlier* `generated_at` is accepted. The gate that refuses a stale regeneration belongs to P4-02, which can compute the current fingerprint.

**A credential in an artifact is refused whole** (D-213). Every other write redacts; this one rejects, and no row is written. Being derived is not an exemption — the text is new, so a clean source does not make a clean artifact — but redaction would leave the wrong thing behind: an artifact is several renderings of one source and one is an embedding computed from the text *before* any redaction applies, so a redacted row reads `[REDACTED]` and still encodes what was removed in the half nobody can read. Same detector, same false-positive line: a summary saying a token expired is stored.

**Excluded from the export** (D-214). Still exactly eight collections, guarded. The store is rebuildable, so carrying it would inflate every backup with regenerable data, and an export is a file that travels. Not restored either, because it is not exported.

**D-202 is fulfilled in this change set** (D-215). The delete path removes the artifact before `change_logs`; the physical-delete test asserts nothing of the Problem survives in any Memory table; phase 3 E2E step 11 creates an artifact and asserts zero rows after the delete, and step 12 is reworded from "no derived store exists" to the forward-looking boundary it now has to be. The exact inventories moved 11 → 12 tables and 12 → 13 foreign keys in the same change. Phase 3 stays **COMPLETE**: no Phase 3 behaviour moved, its exact guards were updated because the schema legitimately grew.

**Ten discrimination mutations, each killed by a named test**: the read's owner predicate removed, the foreign key reduced to `problem_id` (schema-level, with a full `db:reset` around it), the repository handed out unwrapped, reject softened to redact, the artifact dropped from the delete path, `on conflict do nothing`, the upsert also touching the Problem, artifacts joined into the export statement, the fingerprint not stored, and the table dropped from the catalog inventories.

## What is deliberately absent

Do not assume these exist, and do not add them outside the phase that owns them.

- Nothing prevents `VERIFIED` at the database level. The rule is enforced by the transition service, which is the only path that writes status
- No way to reopen a `VERIFIED` or `CLOSED_UNRESOLVED` Problem, and no way to revise a conclusion or a `fix_kind` once one is recorded
- No delete except a Problem's. P3-05 added exactly one destructive operation; there is still no Project, Environment, Event, Verification, Relation or UsageLog delete, no Environment update, no MCP, no AI adapter, no UI. Since P4-01 there is somewhere to *put* an embedding, and still nothing that produces or reads one
- No artifact generator. Nothing computes a summary, keywords, structural features, a fingerprint or an embedding; no model is named or called. P4-01 is storage and its rules (D-216)
- No search, no distance query, no ranking, and no vector index — an untyped `vector` cannot carry one, deliberately (D-211)
- No HTTP surface for artifacts. No route, no OpenAPI operation; the contract stays at 0.4.0 with 27 operations. An artifact is written by a background generation, and what a client may ask for belongs to the task that has a search to expose (D-216)
- No artifact list, query or delete. The repository is exactly `upsertArtifact` and `getArtifact`; the only removal is the Problem's own delete path (D-216)
- No fixed shape for `structural_features` beyond being a JSON object, and no artifact freshness gate — the fingerprint is stored and compared here, computed by P4-02 (D-212, D-216)
- No PII detector, no raw-conversation or raw-log classifier, no large-code threshold. P3-02 and P3-03 are about secrets only; an email address is kept, and that is a statement about secrets rather than a ruling on PII
- No bare-secret detection. A credential with no context at all — pasted alone into a summary, nothing naming it — is not found, because the only way to find it would be to guess from shape (D-122)
- No key redaction. A credential written into an object *key* is refused, not rewritten (D-126)
- No logging backend. No log table, no log endpoint, no retention, no rotation, no external sink, no metrics platform, no Global Audit warehouse. P3-10 is a policy about what may be emitted to stdout (D-191)
- No logger-side sanitizer. Memory’s secret detector is for structured Memory content and is not reused for logs; operational diagnostics are closed values instead, so there is nothing to sanitize (D-184)
- No orphan cleanup. A Project or Environment left with no Problems stays; that is the rule, not a gap (D-136)
- No record that a deletion happened. No tombstone, no delete audit table, and no `changed_by` on the request (D-137)
- No server-side confirmation of user intent. A flag any client can send proves nothing; the responsibility sits with the adapter or UI (D-140)
- No search index or derived cache beyond the retrieval artifact itself. The artifact is the one derived store, it joins the delete path, and it is deliberately not exported (D-141, D-214, D-215). Any *further* derived store arrives under the same rule
- No import. Export proves its format is restorable; reading an artifact back is outside the Core MVP by the specification's own line (D-142)
- No per-project or per-problem export, no streaming, no archive, no export job, no pagination
- No HTTP client, no scheduler and no queue directory default. The retry queue ships an interface, a `drain` the caller drives, and a required path (D-151, D-155, D-158)
- No fallback that sends a write the queue could not record (D-162)
- No notice text, no notification store and no acknowledgement. P3-09 returns a structured intent; wording, timing and dedup belong to an adapter (D-177, D-178)
- No search engine. P3-09 defines the shape one must answer in and nothing more (D-179)
- No workflow orchestration: the fallback answers a question and never runs the caller's work (D-180)
- No enforcement of `memory_write_enabled` on an append. It is stored and settable; whether a replay may proceed against a Problem whose owner has since turned writes off is a rule for the adapter's delivery (D-160)
- No pagination, filtering or search on list endpoints
- No rendered API explorer. The contract is JSON at one path; a UI, a YAML variant and an owner-scoped copy are all absent deliberately
- No client SDK or codegen. The document declares the one scheme the server implements and nothing more
- No HTTP credential management. Issuing and revoking are local commands; there is no endpoint that mints a credential
- No permissions. A credential is all-or-nothing for its owner's memory; `clientId` is carried so that decision has somewhere to go, and nothing consults it
- No expiry, no refresh, no scopes, no rate limiting per credential

## Immediate objective

P4-02 — Retrieval summary generation.

**NOT STARTED.** P4-01 is done; nothing of P4-02 has been implemented.

Notes for whoever picks this up:
- The storage exists and refuses nothing it should accept. What is missing is everything that *produces* an artifact: the summary, the keywords, the structural features, the fingerprint and the embedding
- `source_fingerprint` is P4-02's to define. Storage stores it and compares it for equality and has no opinion about its input; what it must be computed from is the Problem, its Events and its Verifications, because that is what "the state this was built from" has to cover
- The current-state gate is P4-02's too. Storage accepts an *earlier* `generated_at` on purpose (D-212) — a timestamp cannot tell a stale generation from a slow one. The check that refuses a regeneration built from a source that has since moved needs the fingerprint, so it belongs where the fingerprint is computed
- The model is still unchosen, and choosing it is what makes a fixed `vector(n)` and an ANN index possible (D-211). Neither is needed before a search exists; both are cheap while the data is small
- The artifact write rejects rather than redacts (D-213), so a generator must be able to handle a refusal — it is not a failure of the generation, it is a Memory holding a credential

## Core MVP milestone

The Core MVP is not complete until the Phase 7 cross-project E2E succeeds: Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
