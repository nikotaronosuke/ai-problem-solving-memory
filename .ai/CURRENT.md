# CURRENT

Updated: 2026-08-17 (P5-02 milestone closeout)

## Current phase

Implementation Phase 1 — Foundation / Repository / Database: **COMPLETE**

Implementation Phase 2 — Core Memory API: **COMPLETE** (P2-01 … P2-14)

Implementation Phase 3 — Privacy / Security / Reliability: **COMPLETE** (P3-01 … P3-12)

Implementation Phase 4 — Retrieval: **COMPLETE** (P4-01 … P4-15)

Implementation Phase 5 — Claude Code Adapter: **IN PROGRESS**

- P5-01 — connection capability audit: **DONE**
- P5-02 — adapter package / boundary: **DONE**, split into three parts (D-378)
  - P5-02a — package boundary and common Memory API client: **DONE**
  - P5-02b — production retrieval runtime: investigation and design freeze **DONE**
    - P5-02b-impl-1 — RetrievalArtifact lifecycle correctness: **DONE**
    - P5-02b-impl-2a — OpenAI production provider adapters: **DONE**
    - P5-02b-impl-2b — production runtime wiring: **DONE**
  - P5-02c — Search JSON API, owner-scoped retrieval composition, client search method: **DONE**
    - P5-02c-impl-1 — Search JSON API and owner-scoped search composition: **DONE after formal-review correction**
    - P5-02c-impl-2 — the common client's `search()` method: **DONE after formal-review correction**
- P5-03 — Project auto-detection: **NEXT / NOT STARTED**

## Source of truth

Private specification repository `nikotaronosuke/ai-problem-solving-memory-spec`:
- `docs/spec/final-mvp-spec.md`
- `docs/spec/mvp-os-boundary-addendum.md`
- `docs/implementation/mvp-roadmap.md`
- `docs/implementation/phase2-task-breakdown.md`

`docs/reference-set.md` is **not** part of this chain. It holds external ideas so
they are not lost, and it overrides nothing (D-439). Using anything in it requires
the promotion rule (D-440).

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

## What exists now — Retrieval summary generation (P4-02)

Turning one Problem into something a search can compare. A `RetrievalSummaryDraft` — normalized summary, keywords, structural features, source fingerprint — produced in memory and **returned, never stored** (D-217). No migration, no route, no vendor: the schema, the API contract and the three runtime dependencies are all exactly as P4-01 left them.

**Nothing is written down, because an artifact is complete or absent.** The embedding belongs to P4-04, and all four ways to store something now were refused: a zero or fake vector, a placeholder model, a migration making `embedding` nullable, or pulling the provider forward. The draft carries no `generated_at` either — an artifact's is the moment its *complete* content existed, and that moment has not arrived.

**One statement, one snapshot, assembled in SQL** (D-218). Four reads would take four snapshots and could fingerprint a state that never existed. Holding a transaction across the generation was refused too — that keeps a connection checked out for the duration of somebody else's inference — so the read is short and consistency across the call is re-established by reading again. Built in SQL rather than in JavaScript because it was measured: `jsonb` numbers come back through the driver as doubles, so `12345678901234567890` becomes `...567000`, and a build identifier can genuinely be that. The same choice makes Environment key order canonical for free.

**What is in the document decides what regenerates a summary** (D-219). Title, symptoms, domain, boundary, status, fix kind; the Environment snapshot; **all six Event types** with no filter; every Verification including failed ones. Out: confidence, freshness, importance, suppression, both controls, versions, timestamps, identifiers, authorship, evidence refs, and Project, Relations, UsageLogs and ChangeLogs entirely. `DISCOVERY` matters more than it looks — concluding a Problem records the final cause *as* a `DISCOVERY` — and `USER_CORRECTION` is what stops a superseded misunderstanding being summarised as current. Proven by two Problems with the same content and everything else different producing byte-identical documents.

**The fingerprint is the exact bytes the generator saw** (D-220): `retrieval-source-v1:<sha256>` over the document itself, not over a field list. Two questions, one answer. A Memory edited and put back produces the same digest, and that is correct — the digest is over meaning, not history.

**A recorded fix is not a verified one** (D-221). Nothing links a `FIX` Event to a Verification, so `successful_directions` may be non-empty only when the status requires a successful Verification and one exists. Mechanical, in code, and it refuses rather than quietly emptying the list. Neither shortcut was taken: last-`FIX`-wins invents causality from chronology, and all-`FIX`-succeeded is worse. Related limitation recorded: a close-review Event is indistinguishable from an ordinary one, and nothing here guesses.

**`structural_features` v1** (D-222): eight exact keys, unknown refused, missing refused, null-for-a-list refused. Free-form labels rather than a closed taxonomy, because the acceptance condition is cross-technology matching and an enum missing the label a problem needs buries it permanently. Bounds refuse rather than trim. Keyword case is preserved — the full-text search normalises it downstream.

**The generator is a port with no vendor** (D-223). Everything P4-02 owns is provable against a scripted generator, and choosing a model here would also start collecting external provider credentials, which the OS boundary is careful about. The port is handed a string and can be given nothing else — no repository, no executor, no context — so "the Memory text told the generator to modify the Memory" describes something the interface cannot do.

**`memory_read_enabled` blocks generation** (D-224), checked before the generator is called, with zero invocations. Once a real provider exists, calling the generator is when the text leaves the process. Not extended to `memory_write_enabled`, which governs a different act; suppressed and invalid Memories still generate.

**The race is closed by reading again, on three questions** (D-225): still there, still readable, still the same digest — in that order. The fingerprint alone is not enough, because a control toggled mid-generation leaves the document unchanged. A deleted Problem is caught by reading rather than by a foreign key, since nothing here writes.

**Generated output is inspected before it can reach an embedding provider** (D-226). P4-01's boundary is too late by one step: the text goes to a provider before the write. Refused whole, same detector, same false-positive line, nested `x=NAME=value` included — and P4-01's check still stands behind it.

**Held to an exact key set at both levels** (D-229, found by review after the first commit). The output's top-level keys are exactly `normalizedSummary`, `keywords` and `structuralFeatures`; the features' keys are exactly their eight. The first version checked the type and read three fields, so a fourth was accepted and ignored — which could not store anything, since nothing is stored, but would have hidden a generator supplying an identity, a digest or an embedding it has no way to know.

**Fourteen discrimination mutations, each killed by a named test**: the owner predicate dropped, the Environment removed, `DISCOVERY` filtered out, `USER_CORRECTION` filtered out, the document rebuilt through JavaScript, the second read removed, the recheck comparing the new source with itself, the privacy inspection removed, the read touching the Problem, a placeholder embedding on the draft, confidence joining the document, and each of the three gates — initial read control, final read control, successful-direction evidence — disabled in turn.

## What exists now — Full-text search (P4-03)

Lexical candidate retrieval over stored artifacts. A migration (14 → **15**), a domain query type, one SQL statement and an owner-scoped reader. No HTTP, no new dependency, no new table.

**It searches what exists and creates nothing** (D-230). In production this returns nothing today: P4-02 stops at a draft and a draft cannot become a row without an embedding, which is P4-04's. That is sequencing, not a defect — and every way to make the demo prettier was refused, because a zero vector is the row D-211 called the worst outcome. The tests seed real artifacts through P4-01's own repository. A search that generated what it could not find would turn a read into a write while somebody waits.

**The document is the artifact's summary and keywords, and nothing else** (D-231). Not the Problem's title, symptoms or domain — indexing the source beside the translation would give the system two definitions of "the searchable text" and let the second quietly bypass P4-02. Not `structural_features` either: comparing structure is P4-07's and it compares meaning, which a bag of words was measured to do badly while looking done (D-265). Marker tests in the Problem's own text and in the features both must find nothing.

**`pg_catalog.simple`, written out on both sides** (D-232). The server's default is `english`, which stems `Fastify` to `fastifi` and `memory_read_enabled` to `memori read enabl` — measured. `simple` keeps `postgresql`, `node.js`, `v5.1.2`, `@fastify/swagger`, `client_event_id` and `foo-bar` intact. The accepted cost, also measured: `deployment` no longer matches `deployed`. Recall across different words is the semantic half's job; the lexical half should be the exact one.

**Keywords at weight A, summary at B** (D-233). A keyword was chosen as a way to find this Problem; a word in prose may just be there. Measured 1.0 against 0.4 on the same term. `lexicalScore` is named so it cannot be mistaken for confidence, verification strength, or anything comparable with a vector similarity.

**A generated stored column, not an expression index** (D-234). Both use the index; only one fails loudly. An expression index needs the query to repeat its expression exactly, and when it drifts the search still returns correct results and silently stops using the index — 218 ms against 0.1 ms on twenty thousand rows. A column is named, so the same mistake is a missing-column error. `not null`, because it can never be unknown — caught by the existing nullable-column inventory. No trigger: the database recomputes it on every write, and a test proves a replaced artifact is a replaced document.

**The helper is immutable in fact, not just in its declaration** (D-235). `array_to_string` is STABLE, so the natural one-liner cannot be indexed, and the documented workaround — declare the wrapper IMMUTABLE anyway — would be a false declaration that happens to be harmless here and would not be somewhere else. The array is walked in plpgsql instead, using only genuinely immutable primitives. A test strips the function's comments and asserts `array_to_string` is not in it. First user-defined function in `public`; the other 118 belong to extensions.

**`websearch_to_tsquery`** (D-236). `to_tsquery` raises a syntax error on ordinary prose. The limitation carried is recorded rather than hidden: ordinary terms are joined with AND, so one absent word empties the result, and silently dropping terms would be this layer inventing a relevance policy.

**Two things filter; judgements do not** (D-237). Owner and `memory_read_enabled`, both in SQL. The read control matters *here* specifically because the flag can be turned off after the artifact was written — turning off automatic reading is not a delete, and a test flips it and asserts the search misses while the row stays. Suppressed, stale, superseded, invalid, low-confidence and low-importance artifacts are all still returned: being findable and being recommended are different questions.

**A query is ephemeral** (D-238). The secret detector is deliberately not applied to search text — a query is not a stored Memory, and refusing credential-shaped text would break searching for the Memory about a credential leak. What that permits it also obliges: no query text in a log, a UsageLog, a ChangeLog or an error message.

**Japanese is a standing limitation** (D-239). Built-in text search does not segment it, so a Japanese sentence is one lexeme and a word inside it does not match. No extension was installed. Keywords arrive already separated and recover the case that matters, and there is a positive test for it. Deliberately no test asserting the failure, so a future improvement is not a regression.

**Fifteen discrimination mutations, each killed by a named test**: the owner predicate, the read control, the project filter, the self-exclusion, keywords out of the document, the summary out of the document, the weights swapped, the configuration changed to `english`, the index dropped, the search rebuilding the document instead of reading it, the Problem's own text joining the document, the structural features joining it, the tie-break dropped, the limit unbounded, and a blank query accepted.

## What exists now — Embedding provider abstraction and the full pipeline (P4-04)

The composition point three tasks were building towards: a Problem in, a stored, searchable artifact out. `EmbeddingProvider` port (modelId / modelVersion / dimensions / `embed → unknown`), provider-output validation, the generation service, an atomic final gate, and provenance for the pipeline's other generator. Migration 15 → **16**.

**A port with no vendor, recording the model, not the provider** (D-241). No SDK, no HTTP client, no credential, deps still three. Two providers serving one model share a vector space, so provider identity has no column. `dimensions` is required — it is the one property of output checkable without understanding it, and a wrong-size vector is unfindable, since cross-dimension distance is an error (measured).

**Output validated, zero vectors refused everywhere** (D-242). Exact declared length, all finite, not all zero; nothing coerced, truncated or padded. The zero rule is a measurement: PostgreSQL stores an all-zero vector and its cosine distance is NULL — the "saves cleanly, breaks every later search" row. The refusal was promoted into `toEmbedding` itself, so no repository caller can store one either.

**The embedding input is `normalizedSummary`, verbatim** (D-243). The summary's contract already covers what should be embedded; provenance is free because the model's input is byte-for-byte the stored column; and the hybrid stays a hybrid — keywords are the lexical channel's, features are the structural task's.

**Summary generator provenance is stored** (D-244): `summary_generator_id` / `summary_generator_version`, NOT NULL, closing D-227's deferred gap — a summariser change leaves the fingerprint untouched, so these columns are the only way an old-summary artifact stays identifiable. The migration deleted the existing derived rows rather than backfilling fake provenance; nothing touched a Memory table. Four separate provenance axes: what was read, who wrote, what vectorised, when complete.

**`generated_at` = when the complete content first existed** (D-245): clock read once, after embedding validation, before the gate. First injected clock in the codebase (`now` defaulting to `new Date`), pinned by a call-order test: embed → now → transaction.

**The final gate is one short transaction under `FOR UPDATE` on the Problem row** (D-246). Measured against the real schema: while held, Event and Verification appends block (their FK checks need a key-share lock on the row), every Problem update blocks — read control included — deletes block, and so does a competing artifact upsert. So the re-read, the fingerprint check and the write are one act, and concurrent generations serialise with no half-writes. External calls happen strictly before the transaction. The Environment is not locked because it is immutable — **a change making it mutable must revisit this gate in the same change set**.

**The commit guarantees exactly one thing** (D-247): at that moment, the fingerprint described the source. Staleness a moment later is ordinary and belongs to revalidation. Outcomes are the summary service's three plus `STORED`; no created/replaced distinction. Failed generations preserve an existing artifact — except a mid-generation Problem delete, which correctly takes its artifact with it. Concurrent model rollout is an accepted, recorded limitation: **one configured provider per deployment** is the standing assumption.

**Service-owned flow** (D-248): no draft-accepting API exists, so the only text that can reach a provider is a draft that survived P4-02's validation, privacy inspection and race check — proven by a credential-bearing summary being refused with the provider call count at zero. Provider failures are a fixed sentence, no cause chained. The artifact write still crosses the sanitized repository, built inside the gate — the second approved construction site, both guarded.

**Proven end to end with scripted ports on the real database** (D-249): generate → embed → gate → store → find with the lexical search. What a deployed server still cannot do — and is not claimed to do — is generate artifacts by itself: no concrete generator, no concrete provider, no caller, no scheduler.

**Sixteen discrimination mutations, each killed by a named test**: the dimension check dropped, both zero-vector rejections dropped in turn, the provider error passed through, the fingerprint comparison dropped, the read-control recheck dropped, the lock dropped, the repository used raw, the model identity unstored, the generator provenance unstored, the clock read early, a failure deleting the existing artifact, a placeholder-vector fallback, a vendor SDK import, a UsageLog write, and a distance operator in the generation path.

## What exists now — Vector search (P4-05)

Semantic candidate retrieval: text in, nearest memories out. A service that embeds the query, a reader over one statement, no migration, no new dependency, no route.

**The query is text, embedded by the service itself** (D-250). The same provider instance the artifacts used produces the query vector, and its declared model/version/dimensions are the compatibility filter — so a query cannot be from the wrong space *structurally*. No raw-vector application API exists, and a guard keeps the service and request interfaces vector-free. P4-04's port, output validation and failure error are reused; `EmbeddingGenerationFailedError` moved to the embedding domain now that it has two callers.

**A confirmed credential in the query is never transmitted** (D-251). The lexical search lets such queries through because they live and die inside the database (D-238); a semantic query goes to a provider — somebody else's computer — so the same certainty line produces the opposite rule. Inspection happens before the embed call, yields typed `SENSITIVE_QUERY_NOT_EMBEDDED` carrying nothing but its kind, provider called zero times, no search run. Suspected and status prose still pass. The gate is a sanitization *policy* (`createSemanticQueryInspectionPolicy`) rather than detector use in the service — the guard keeping credential knowledge inside `sanitization/` caught the first draft, and was right.

**Cosine, fixed; compatibility is three tests** (D-252). `<=>` as a system decision, pinned by the magnitude fixture (same direction at 100× ties at 0.0; L2 would say 99 — operator swap fails the test). Rows compare only when model AND version AND `vector_dims` all match; a same-model six-dimensional row neither errors nor eats the limit. Old-embedding-model artifacts are invisible here and findable lexically — the hybrid's halves failing differently, on purpose. No regeneration at query time.

**Raw `cosineDistance`, no threshold, shared filters** (D-253). Lower-is-better with the metric in the name, so summing it with `lexicalScore` is visibly wrong. Opposite vectors return when nothing closer exists — usefulness is the merge/rerank/evaluation stages' question. One resolver shares project/self/limit validation with the lexical search; the semantic text bound is 4000 (a whole normalized summary is the canonical query), the lexical 1000 unmoved. Owner and read control hard in SQL; suppression/freshness/confidence/staleness returned, not filtered.

**Exact scan, ANN deferred on measured grounds** (D-254). The spec asks for retrieval, not an index; an ANN index cannot exist on an untyped column and no model is chosen to type it; 10k×64d answered in ~7 ms in the probe. Migrations stay 16 and vector indexes 0, asserted as boundary tests a hardening task will deliberately update; the partial cast-index path is measured and open. A search writes nothing — proven byte-for-byte across all nine tables.

**The privacy policy is not injectable** (D-255, found by review after the first commit). The factory shipped with a `queryPolicy` parameter defaulting to the safe policy; a caller could have passed one that keeps everything and dissolved the rule at that call site. A safe default is not a boundary — the boundary is having nothing to override — so the parameter is gone and the policy is built inside the factory. A named guard asserts the *absence* of the seam: restoring the parameter, even safely defaulted, fails it.

**Eighteen discrimination mutations, each killed by a named test or guard**: the owner predicate, the read control, each of the three compatibility predicates in turn, the project filter, the self-exclusion, the metric swapped to L2, the tie-break, the limit bound, unchecked provider output, the provider error passed through, the sensitive-query gate, a regeneration on miss, a usage-log write, old-model rows included, an ANN migration arriving, and a raw-vector public API.

## What exists now — Hybrid candidate retrieval (P4-06)

Both searches as one intent, fused by rank into a bounded candidate list — the first of the specification's two retrieval stages. A pure fusion function and an orchestration service. No migration, no dependency, no route; the only other production change is one `readonly ownerId` on the vector service.

**Two texts, and no query generation** (D-256). `lexicalText` (≤1000) and `semanticText` (≤4000) are different questions with different bounds, so one string cannot serve both. Deriving one from the other would mean deciding what the search is really asking — a policy that would sit here untested — so there is no extraction, summarising, stop-word removal or truncation. Filters appear once and apply to both: a list fused from two differently-scoped questions answers neither.

**Everything is validated before either channel starts** (D-257), because running the semantic half means a network call to a provider, and doing that for a request that was never going to validate sends text for nothing. Counted in tests: an invalid lexical text leaves the provider at zero calls, an invalid semantic text leaves the database at zero.

**The channels must share an owner, checked at construction** (D-258). Each is owner-safe alone and neither can see the other, so a pairing across owners would return two people's Memory with both halves behaving correctly. The vector service now reports its reader's `ownerId`, the factory compares, and a mismatch refuses to build — naming no identifier.

**Rank fusion, k=10** (D-259). The scores cannot be combined — opposite directions, incomparable scales, and min-max was measured to collapse on small or equal-scored channels — so only the ordering is read. On `k`: the published 60 was calibrated for thousand-deep lists and against a twenty-deep window flattens rank 1 against rank 20 to a ratio of **1.31**, letting a candidate placed *last* by both channels outrank one placed *first* by a channel. k=10 gives 2.73, and agreement wins down to about rank 11 — half the window. Both halves of that trade are pinned by tests.

**A fixed source window, a stage-shaped limit** (D-260). Each channel is read to 20 regardless of the caller's limit — deriving depth from the limit was measured to change the top ten — so a limit of 10 is exactly the prefix of a limit of 20. The final limit is 10–20: the floor exists because asking this stage for one result takes the reranker's decision with none of its information. Short lists are returned short, never padded.

**A null rank is not evidence against a Memory** (D-261). It can mean no match, or outside the window, or a superseded embedding model, or the semantic channel not running — so absence contributes nothing and subtracts nothing, and lexical-only candidates are first-class. Raw scores are dropped after ranking so two incomparable numbers do not travel onward inviting a second, different combination. One Problem twice, or under two Projects, is refused rather than reconciled.

**Exactly one failure degrades** (D-262). An unreachable provider turns the semantic half off and says `PROVIDER_UNAVAILABLE`; a malformed provider response, a database error and a broken invariant are all raised, because a broken component behind a plausible result is the failure that takes longest to notice. A credential in the semantic text yields `SKIPPED_SENSITIVE_QUERY` with the lexical half running normally — the ordinary path that asymmetry was designed for.

**Twenty discrimination mutations, each killed by a named test or guard**: duplicates double-counted, each channel's order reversed, a channel's contribution dropped, the tie-break removed, the limit ignored, a sensitive query emptying the search, outage tolerance removed, raw scores added, confidence weighting, structural fetching, a usage-log write, the owner check removed, single-channel candidates dropped, absence penalised, a caller-settable k, source depth following the caller's limit, validation moved after execution, a caller-supplied owner, and malformed output hidden as an outage.

## What exists now — Structural reranking (P4-07)

The second of the specification's two retrieval stages: ten-to-twenty candidates narrowed to one-to-five by whether they are the *same kind of problem*. A pure domain module, a batch read, a reader, and an orchestration service. No migration, no column, no dependency, no route.

**The schema is eight keys, six of them lists** (D-264) — `schema_version`, `problem_domain`, and the six label lists D-222 defined. This document previously said "eight free-form label lists", which counted the version and the domain as lists; the code has always been exact-key and is unchanged. P4-02's parser is now exported and reused for stored features, because two parsers for one schema would eventually disagree. The success-claim gate did **not** move: it depends on the Problem's status and Verifications, which a reader of stored artifacts cannot see, so shape validation is shared and the gate stays at generation time.

**A model compares, and the measurement is why** (D-265). Exact label overlap, token Jaccard and character-bigram similarity were all built and measured first; all three ranked *same technology, different cause* above *different technology, same structure* — the inversion of this stage's purpose. Rewriting the same structure in different vocabulary scored the cross-technology candidate **0.000 / 0.159** against the surface-similar one's **0.048 / 0.208**. The acceptance condition is that a React ordering bug can surface a Fastify one, and word overlap cannot see that because the words are what differ.

**Scripted rerankers prove the orchestration and nothing about model quality** (D-265). Semantic quality is P4-14's, measured against fixtures. No test here is written as though it had been settled.

**Its own vendor-free port, not the embedding provider** (D-266). `StructuralReranker` takes a shape and returns `unknown`; no SDK, no HTTP client, no credential, and no `rerankerId` — nothing is persisted, so an identity would be a field with no reader.

**The current profile is supplied by the caller and parsed** (D-267). The Problem being worked on is the one least likely to have an artifact and most likely to have a stale one, and a search must not write. An unparseable profile reaches neither the database nor a model.

**Candidates are re-read in one statement** (D-268), owner and `memory_read_enabled` applied again, three columns only. Deleted, artifact-missing, read-disabled and another owner's are one indistinguishable answer — pinned by comparing a stranger's identifier against an invented one.

**Unreadable stored structure stops the whole stage** (D-269), rather than dropping the candidate: removing it would be indistinguishable from judging it dissimilar, and there is nothing wrong with the Problem. Every candidate is returned in the first stage's order with null scores and `STRUCTURAL_DATA_UNAVAILABLE`.

**The model sees two structural profiles and nothing else** (D-270). No project, no fusion score, no source ranks, no summary, no keywords, no limit — a model shown the first stage's ordering could reproduce it and call it a judgement.

**The privacy check is re-run here and the policy is not injectable** (D-271). Both inputs have been through none of this system's write checks — one came from a caller, one came out of a database, which vouches for storage rather than content. A confirmed credential means the model is not called; the result says only `SKIPPED_SENSITIVE_INPUT`.

**Exact coverage, 0–1 scores, named evidence** (D-272). Every candidate back exactly once — omissions would put a hidden threshold inside the model, and this stage has none on purpose. A score above zero must name at least one of the seven comparison dimensions, and a score of zero must name none.

**A claimed dimension must have had something on both sides** (D-276, found by review). Empty on either side is refused — `successful_directions` above all, where an empty list means the record does not support a claim and never that a fix failed. Availability only: no text is compared and no overlap is required, because deciding the match here would be the arithmetic D-265 rejected, arriving as a validation rule.

**A hybrid rank is provenance, not an index** (D-277, found by review). If the second of three candidates is deleted between the stages, the third is still rank 3. Renumbering the survivors would rewrite the earlier stage's answer and hide the gap that says something disappeared. Preserved on the judged path and all four degraded paths.

**Structure decides, hybrid rank breaks ties, the limit is 1–5 defaulting to 5** (D-273). The two scores are never added. The default is the ceiling because how many to show is a presentation decision and a ranking stage still sits between this and a reader.

**An unreachable reranker degrades; a malformed answer raises** (D-274). Degraded scores are null, never zero. Zero or one candidate is `NOT_NEEDED` with the reranker uncalled.

**Forty-two discrimination mutations, each killed by a named test or guard**: the schema version as a dimension, the default cut, both bounds, an unparsed caller profile, a refusal quoting the profile, duplicate candidates, unchecked fusion scores and ranks, self-exclusion removed, extra keys at both levels, omitted / invented / repeated candidates, an out-of-range score, an unknown or repeated dimension, evidence-free scoring, the tie-break and the null-score ordering, a threshold introduced, the read control and the owner filter dropped, the summary pulled into the batch read, an injectable policy, inspection removed, a credential no longer stopping the call, a candidate quietly dropped, the cross-Project invariant, a one-candidate model call, an invented degraded score, the availability check and each of its two sides, `successful_directions` exempted from it, and the ranks renumbered on the judged path, on the degraded path and by being read after the re-read. Three survived a first run — two bounds asserted against themselves rather than against their literal values, and an identity check masked by the newer availability check — and in each case the test was fixed rather than the mutation dropped.

## What exists now — Ranking policy (P4-08)

The last retrieval stage: what order a handful of Memories are offered in. A pure ordering function, a one-statement read, a reader and a service. No migration, no dependency, no route.

**Arithmetic, not a model** (D-278). Every input is a stored control, an identifier or a number that already exists, so the boundary that puts semantic judgement behind a model and routine work in code falls exactly between P4-07 and this. No port, no network, no vendor, no privacy inspection — nothing crosses a process boundary — and therefore no degraded status of its own.

**`Project.platform` is what "same technology" means, folded for case only** (D-279). The one field claiming to name a Project's technology; `repo`, `problem_domain` and `Environment.snapshot` are none of them a technology identity, and building one for a tie-break was refused. `React` matches `react`; **`Node.js` does not match `node`** and `React` does not match `React Native`, recorded as known limits. A missed match costs a tie-break, an invented one asserts a shared stack nobody claimed. Null on either side is unknown, never different.

**Four exclusive relations** (D-280): current Project, same technology elsewhere, other technology, unknown technology. Exclusive by construction so proximity is never credited twice. The last two rank alike and are named apart. The raw label is read to classify and never returned.

**A lexicographic tuple with no weights and no threshold** (D-281): not suppressed → currency → trust → structural score (only when the rerank ran) → proximity → hybrid position → identifier. A weighted sum was simulated and rejected: the weights are invented, and measured, a same-technology bonus of 0.86 reverses an order that 0.5 leaves alone. Nothing is removed — suppressed, invalid, conflicted and structurally-unlike candidates all come back, last.

**Structure outranks proximity, and that is the specification** (D-282). Every proximity-first arrangement let a same-technology candidate scoring 0.05 beat a cross-technology one scoring 0.95 — the system's acceptance condition failing. The search order is the order the search *widens*, so it decides between equally trusted and equally similar candidates and comes to the front whenever the rerank did not run. Consequence, pinned by a fixture: 0.7 current / 0.8 same-tech / 0.95 cross-tech come back in reverse. Trust and currency still sit above structure.

**A missing score is skipped or refused, never zeroed** (D-283, D-288). `USED` means every score exists; the four degraded outcomes mean none does, and a mixture is refused rather than repaired. The comparator itself carried a `?? 0` under a comment claiming it did not — unreachable through the service, and reachable in one direct call to an exported function — so it now raises instead, naming neither candidate nor value. Both directions are one rule, and the guard reads the code rather than the comment above it.

**No importance, no status, no clock** (D-284). Importance has no ranking rule in the specification and is a boolean; boosting `VERIFIED` would count verification twice, since confidence already reflects it; a timestamp would contradict the field that exists to say how current something is. Guards fail on all three.

**Every input read from the database, in one statement** (D-285). Trust, currency, suppression and the label are never taken from the caller — they are editable, so suppressing a Problem must take effect on the next search. Owner and `memory_read_enabled` re-applied; a foreign current Project fails exactly as one that never existed; zero candidates touches the database not at all.

**Two positions kept apart** (D-286): `hybridRank` keeps its gaps, `rankingRank` is this stage's contiguous final position. `matchedDimensions` and the structural status are carried unchanged and never weighed.

**Forty-three discrimination mutations, each killed by a named test or guard**: the owner filter and read control dropped, an unscoped Project join, a timestamp pulled into the read, suppression removed / made exclusion, currency and trust dropped or reordered, invalid ranked as merely untrusted, conflicted above weak evidence, structure dropped or placed after proximity, a missing score read as zero, both tie-breaks dropped, the two positions conflated, matched dimensions counted, a magic weight, a threshold, unknown technology called same or different, case folding dropped, a substring match, the current Project double-counted, each request check disabled, caller metadata believed, a foreign Project accepted, the cross-Project invariant skipped, a vanished candidate raising, an empty ranking querying, the label returned, the outcome dropped, the strict null check removed, the coalescing restored, and the refusal quoting a candidate. Eight survived a first run — six fixtures whose expected order matched the identifier tie-break, one rule tested only through inputs another rule constrained, one stale anchor — and every one was fixed in the tests.

## What exists now — Search and its cache (P4-09)

The three retrieval stages as one call, with a short-lived memory of searches already run. A key module, a bounded map and an orchestration service. No migration, no dependency, no route.

**The composition is the point** (D-289). Until now each stage had a factory and no caller, and the specification's rule about not repeating a search is a statement about a whole search. A caller names the Problem being worked on, the two texts, a structural profile, an optional Project filter and the two limits — and gets one of four outcomes, three of which are ordinary rather than exceptional.

**What is reused is the rerank result; ranking always runs again** (D-290). The cache holds the output of both expensive calls. Every candidate control — confidence, currency, suppression, a Project's label, reading, existence — is re-read on every search, so suppressing a Memory takes effect immediately even when nothing was recomputed. Both paths reach ranking through one function.

**Sameness is the canonical source** (D-291). P4-02's fingerprint, reused: semantic fields, Environment, every Event, every Verification, and none of the controls. **`Problem.version` was measured and rejected** — appending an Event or a Verification does not move it, so a key built on it would answer with a search made before half the investigation existed.

**The key is a digest and the inputs are not kept** (D-292). SHA-256 over a fixed-order JSON array, prefixed `retrieval-cache-v1:`. JSON rather than a delimiter, because no value can then impersonate a field boundary. No trimming, folding or sorting of the search itself — a missed reuse costs a recomputation, an invented equivalence answers the wrong question. Limits are resolved to their effective values first, so an unstated limit and the default are one search.

**A process-local map, bounded and short-lived** (D-293). Five minutes, a hundred entries, injected clock, no dependency, no schema — **D-202 does not fire because nothing is persisted**. Recency is the `Map`'s insertion order; reading refreshes it and deliberately does not extend the expiry. One instance serves every owner, which is why the owner is in the key; the cache is injected, because one built per request would be empty every time.

**The current Project comes from the Problem** (D-294). `RetrievalSummarySource` gained a `projectId` metadata field — outside the canonical document, so no fingerprint moves and P4-02 is unchanged. Naming one Problem and another Project's neighbourhood is unstateable, and so is disagreeing about which Problem to exclude.

**The Problem is read twice on a miss** (D-295). Two network calls is a long time in a system where an assistant appends Events while it works, so a fingerprint that moved yields `CURRENT_SOURCE_CHANGED` — nothing ranked, nothing cached, and no retry loop.

**Only a clean search is kept** (D-296). Semantic used, rerank used or not needed. Every degraded outcome is a statement about a moment, and freezing one would outlast its cause. Invalidation is three layers and no write-path hooks; **the rest of the Memory can be up to five minutes stale, recorded as a limitation rather than hidden**.

**No single-flight, no cache status** (D-297). Two simultaneous identical searches both run — a known limitation. Reuse is proven by counting provider and reranker calls, not by a field in the result.

**Thirty-seven discrimination mutations, each killed by a named test or guard**: each key component removed in turn, the key sorted / case-folded / joined with a separator / left unhashed, copies shared in either direction, the lifetime unchecked or off by one, reading extending the expiry, the bound removed, recency not refreshed, an expired entry answered once, degraded searches kept, ranking skipped on reuse, the second read removed, a changed Problem kept anyway, an unavailable or read-disabled Problem searched anyway, self-exclusion dropped from either stage, unresolved limits, owners uncompared, storing before ranking, the Project taken from the first read, and the Project moved into the canonical document. Four survived a first run — one mutation that changed no behaviour and three guards too loose to see the change — and each was fixed rather than accepted.

## What exists now — Search usage logging (P4-10)

A completed search records that each Memory it surfaced was surfaced. One new module, one new argument, no migration, no dependency, no route.

**One action, because a search observes one** (D-299). `SEARCHED` and nothing else. Candidates dropped by the hybrid or rerank stages are **not** `EXCLUDED` — that means considered and set aside, and a stage narrowing its own window is not an AI declining a Memory. Returning a result is **not** `REFERENCED`. The four other actions stay with the explicit path an adapter uses when it observes them.

**The rows are the final candidates** (D-300). One per Memory a caller was actually shown — never the hybrid stage's wider net, never the rerank's intermediate set. A search that surfaced nothing writes nothing: a row needs a Memory to point at, and pointing it at the Problem being worked on would record a use that never happened. The three non-search outcomes write nothing.

**Degraded but surfaced is still recorded** (D-301). Cache eligibility and log eligibility are different questions: a provider outage is not worth freezing for five minutes and can still end with real Memories being offered. The reason carries both statuses.

**A reused search is a second observation** (D-302). A cache hit writes fresh rows — the Memories were offered again, to whoever asked this time. Logged from the ranking produced now, never the cached rerank, so a Memory since deleted or switched off is not resurrected into an audit trail. No cache status is recorded.

**Who searched is invocation context** (D-303). `search(request, invocation)`. It is deliberately not part of what makes a search the same search, so one assistant's result serves another and each is recorded under its own name — the specification's "Memory is common, only the usage history is per AI", made structural. Validated in preflight with the usage log's own rule; a search that could never be attributed reaches no database and no provider.

**The reason is server-composed from a closed vocabulary** (D-304): rank, Project relation, both channel statuses, comparison dimensions, in one fixed shape. No structural score, no trust controls, no identifiers, no technology label — and `comparison_dimensions` is worded neutrally because the rerank guarantees both sides had content, not that the contents agree. `result` is null.

**A degraded rerank names no dimension, decided by the status** (D-309, found by review). The code had been reading the list instead, which agrees with the status only because the stage upstream happens to be wired correctly — and `composeSearchedReason` is exported. A direct call could produce `structural_status=RERANKER_UNAVAILABLE; comparison_dimensions=symptom_patterns`, a permanent row claiming evidence from a comparison that never ran. The writer now refuses the contradiction outright, which stops a caller being told a search was recorded while half their input was dropped.

**A narrow writer through the sanitized boundary** (D-305). One method, no field for a query or a profile — a shape with nowhere to put the text beats a rule somebody has to remember. One transaction around the rows and nothing else; the provider and model are long finished. The writer's owner joins the construction check, with a test where only the writer is foreign.

**Best effort, never silent** (D-306). A lost record does not lose a search that cost two network calls; it goes to a required reporter with no default, carrying a kind and a count and nothing else. The retry queue is untouched — it replays writes with an idempotency key, and a usage log has none.

**The cache and the log succeed independently** (D-307). The cache is filled first, so a lost log line cannot discard a result worth reusing.

**Twenty-nine discrimination mutations, each killed by a named test or guard**: the action changed or added to, a row for a search that surfaced nothing, a non-search outcome logged, a query field on the writer, a score or a trust control in the reason, dimensions called matches, a degraded rerank claiming evidence, the earlier stage's rank reported, a result claiming success, the searcher unrecorded or unvalidated or added to the cache key, the cached rerank logged, a reused search unlogged, the rows written one at a time, a lost record swallowed or rethrown, the report growing a detail field, the reporter defaulted away, the writer's owner unchecked, the record written before the search was reusable, the rerank status no longer deciding whether dimensions are named, degraded treated as used, the neutral fallback dropped, the rule widened to the semantic channel, the contradiction check removed, and the refusal made to name what it refused. Eight survived a first run — five stale anchors, two defence-in-depth checks each hidden by the other, one mutation that left the original call behind — and each was fixed rather than accepted.

## What exists now — Revalidation contract (P4-11)

Every Memory a search offers now carries what it was recorded under and what has to be re-established before acting on it. Four new modules, one changed field on the search outcome, no migration, no dependency, no route.

**The server says what a Memory was true of, not whether it still is** (D-310). It has no working tree, no manifest, no running process and no way to read a vendor's documentation — everything that would settle the question lives where the work is happening. So the request takes no `currentEnvironment`, `currentCode`, `currentVersion` or `currentSpec`; the current Problem's own snapshot is not "now" either; and there is no model, no provider and no network on this path.

**The checklist is the specification's four and never shrinks** (D-311): `CURRENT_CODE`, `CURRENT_ENVIRONMENT`, `RELEVANT_VERSION`, `OFFICIAL_SPEC`. Not reduced for a `CURRENT` freshness, `HIGH` confidence, or a Memory from the current Project — **`CURRENT` is a statement about the record, not the world**, and the specification says the confirmation is not skipped for a trusted or important Memory. The array is `Object.freeze`d, because one array is shared by every candidate in the process and `readonly` is gone at run time.

**The Environment comes back verbatim** (D-312). Which keys a snapshot carries is not fixed, so extracting an OS or a version list would mean guessing at a schema that does not exist. An empty object is an ordinary snapshot. No `environmentId`, no Environment timestamp, no Project detail.

**Evidence is Verifications, failures included** (D-313). A check that failed says what was tried and did not settle the matter; keeping only successes would make every Memory read as though everything attempted had worked. Payload: `verificationType`, `result`, `summary`, `evidenceRef`, `createdAt` — no ids, no `verifiedBy`. **No cap**, because the specification names no number. Ordered `created_at` then `verification_id`. `evidenceRef` is returned as a reference and never fetched, resolved or checked.

**One statement, three cases kept apart** (D-314). `unnest(...) with ordinality` with everything left-joined outwards: a Problem that is gone is dropped (all four reasons indistinguishable), a Problem with no Environment is **raised** — impossible against a not-null column and a composite foreign key, and a test confirms the database refuses to create it — and a Problem with no Verifications returns an empty list. An inner join would report a broken database as a Memory that vanished.

**Two positions, one renumbers** (D-315). `rankingRank` closes up when a candidate drops out because it is the position actually offered; `hybridRank` keeps its gaps. Candidates are rebuilt, so the caller's array is untouched, and nothing is re-run.

**The positions given must be the order given** (D-320, found by review). Survivors are renumbered from their place in the array, which is only correct if the array *was* the order — so a candidate at index *i* must state position *i + 1*, checked before the reader is called. Called directly with reordered or gapped positions, the service would otherwise have renumbered to something agreeing with neither, and the result would have looked ordinary. One comparison does all of it: the right-hand side is an integer, so fractional, infinite and `NaN` positions fail it already, and a redundant `Number.isInteger` was removed rather than kept.

**The envelope wraps rather than widens** (D-316). `RetrievalMemoryCandidate { ranking, revalidation }` — the ranking type is unchanged and guarded against ever mentioning an Environment or a Verification. `freshness` stays in one place. No `isStale`, `needsUpdate` or `isSafe`.

**Fresh on every search, stored nowhere** (D-317). A Verification appended to a *candidate* does not move the current Problem's fingerprint, so a cached enrichment would go stale with nothing to notice.

**A failed read is not disguised as a search** (D-318). Database failure and the missing-Environment invariant both raise rather than returning an empty context; that is product data the contract requires, unlike the usage log's best-effort write.

**Thirty-three discrimination mutations, each killed by a named test or guard**: the checklist unfrozen or shortened, a current or trusted Memory excused, conditions omitted or interpreted or taken from the wrong candidate, evidence omitted or filtered to successes or capped or reordered, the tie-break dropped, a reference or summary dropped, an identifier added, the owner and read filters dropped, a missing Environment silently dropped, a vanished Memory returned hollow, positions unrenumbered or provenance renumbered, order taken from the database, the caller's list edited, both request checks disabled, enrichment skipped on a reused search, the log naming pre-enrichment candidates, the revalidation owner unchecked, and the input-position check removed, off by one, applied to the first candidate only, softened to rounding or moved after the database read. Four survived a first run — two stale anchors, one fixture reusing a single identifier so the duplicate rule fired before the bound could, and one owner check covered by the others — and each was fixed rather than accepted.

## What exists now — Dead-end handling (P4-12)

Every Memory a search offers now also carries the directions already recorded as not leading anywhere. Five new modules, one moved type, one added field, no migration, no dependency, no route.

**A warning, and never a prohibition** (D-321). The specification says so in four places and makes it an acceptance test, so it is what the task is built around. No candidate is dropped for having dead ends, no order changes because of them, and the warning type carries no `retryBlocked`, `severity`, `approvalRequired` or `notify` — the service is guarded against sorting or filtering on the list at all. **A direction that failed under one runtime or one library version may be right under another**, and the record cannot tell which; an environment difference is a legitimate reason to try again, which is exactly what P4-11's historical Environment and its four checks are for. They arrive together and the caller decides.

**No post-ranking penalty, deliberately** (D-321). `dead_end_directions` is already one of the seven dimensions the reranker weighs (D-262) — a comparison of *structure*. A second, arithmetic penalty on how many `DEAD_END` Events happen to exist would rank a Problem down for being honestly recorded and would double-count the comparison already made. The ranking modules are guarded against mentioning dead ends at all.

**The Event is the source, not the search profile** (D-322). A stored artifact carries `structural_features.dead_end_directions` and it would have been the cheaper read, since it is already fetched for reranking. It is a generator's paraphrase — regenerated whenever the artifact is, never reconciled with the Events it came from — and fine for comparing structure. A claim about something that happened has to come from the record of it happening, so the read goes to `public.events` and the modules are guarded against naming the artifact at all. A test makes the two deliberately disagree and requires the Event's wording to come back and the artifact's not to appear.

**No cancellation is inferred** (D-323). A `USER_CORRECTION` recorded after a `DEAD_END` does not retract it: nothing links the two, and deciding that one cancels the other would mean reading free text and guessing which earlier Event it meant. A dead end recorded stays a historical fact; whether it still applies is what the revalidation contract hands back. The correction itself is not a dead end and does not appear in the list.

**All of them, oldest first, never merged** (D-324). No cap — the specification names no number and the surrounding bounds already keep the total small. Ordered `created_at` then `event_id`, because Events written in one transaction share a timestamp to the microsecond. Two dead ends with identical text stay two: two moments, possibly two reasons.

**Four fields and a time** (D-325). `summary`, `result`, `reason`, `evidenceRef`, `createdAt`, with `null` returned as `null` and never filled in. No `eventId`, `ownerId`, `problemId` or `clientEventId` — the candidate already names what a reader needs — and no `sourceAi`, because which assistant hit the dead end is not what makes it worth knowing. `evidenceRef` is returned as a reference and never followed.

**One statement, two answers kept apart** (D-326). `unnest(...) with ordinality` with the Problem and its Events joined outwards, owner and read control re-applied in the join rather than a `where`. A Problem that is gone, was never this owner's, or has reading switched off is dropped, all four indistinguishable; a Problem with nothing recorded gets an empty list. "Nowhere is known not to lead" and "this Memory is no longer available" are different statements, and the second must never be delivered as the first. `DEAD_END` only — a guard names the other five Event types and requires none of them.

**The envelope moved out of the stage that introduced it** (D-327). `src/domain/retrieval-result.ts` now owns `RevalidatedMemoryCandidate { ranking, revalidation }` and `RetrievalMemoryCandidate`, which extends it with `deadEndWarnings`. Neither stage owns the answer; each owns its contribution. P4-13's conflict comparison attaches the same way.

**Fresh on every search, stored nowhere, finished before anything is kept** (D-328). A `DEAD_END` appended to a *candidate* moves nothing the cache key watches, so a remembered enrichment would keep sending people down a known-bad direction for five minutes with nothing to notice. A test appends one between two searches and requires the cache-hit search to show it with the provider and reranker still at one call each. The cache is filled and the usage log written only after this stage succeeds, and the log's ordering is a data dependency rather than a lucky arrangement of lines.

**A failed read is not answered as "nothing recorded"** (D-329). An empty list is a positive statement, and a connection that failed has established nothing of the sort; swallowing it would present a Memory full of known dead ends as one with none. A candidate that has become unreadable is dropped and the positions close up — a different thing, and the query is shaped so the two never look alike.

**Forty-one discrimination mutations, each killed by a named test or guard**: every Event type treated as a dead end or a correction or an attempt read as one, the owner filter dropped, the read control not re-applied, an Event taken from another owner's or another Problem, either join made inner, the caller's order or the timestamp order or the identifier tie-break dropped, the warnings capped or de-duplicated, a Problem with none left out of the answer or an empty join row reported as a warning, a row for an invisible Problem kept, an absent result or reason or reference filled in, the summary swapped for the reason, the Event's identifier carried out, the empty request still costing a round trip at either gate, the count bound and duplicate and position checks removed or moved after the database read, the refusal naming what it refused, a vanished Memory returned hollow, a Memory dropped for having warnings, the candidates sorted by warning count, positions unrenumbered or provenance renumbered, the caller's candidate edited in place, the historical context dropped in passing, a retry judgement attached to a warning, the stage skipped on a reused search, the cache filled before it succeeded, a failed read reported as none, and a foreign dead-end stage composed into a search. Six survived a first run: three were undetectable through behaviour and were re-aimed at the guard asserting the statement's text — a defence-in-depth owner predicate, a left join equivalent to an inner one here, and an `order by` the Map-keyed consumer does not depend on — all three kept, because the statement is exported and being deterministic on its own is worth having. The other three were real gaps and the tests were fixed: a key set checked only indirectly, an empty-list gate proven at the statement but not the service, and a fixture whose expected order agreed with what a warning-count sort would produce. A seventh detector turned out to be a coin flip on random identifiers and was re-aimed at a fixture that contradicts the mutation by construction. **A second round injected twenty-four forbidden constructs** — the derived profile wired in as the source, a dead-end count on the ranking view, a warning penalty on the ranking request, the reranker's dead-end dimension removed, `currentEnvironment` and `plannedAction` on the request, an `evidenceRef` followed, the filesystem reached, Relations fetched, the envelope growing a conflict field or redefined in the module it came from, the warnings cached, the log written early, `EXCLUDED` introduced, an Event written, a freshness updated, an HTTP surface, a migration — and two survived, both real gaps now closed: the stage could have read `process.env` or `process.platform` and compared the record against *its own* surroundings, and the envelope's field set was never pinned so a conflict field could have landed ahead of the stage meant to fill it (D-331). Sixty-five in total, all caught.

## What exists now — Conflict handling (P4-13)

Every Memory a search offers now also carries what was recorded as disagreeing with it, and the material for working out which applies here. Four new modules, one renamed type, one added field, no migration, no dependency, no route.

**Material, never a verdict** (D-332). The specification says a conflict is not settled by majority: what gets compared is the difference in environment, in version, in symptoms, the stated reason, and the strength of the verification behind each — and if that cannot settle it, the record stays `CONFLICTED` rather than being resolved. Every one of those five the server can supply; none is one it can judge. So there is no `winner`, no `preferred`, no `canonical`, no `resolved`, no `conflictScore`, no `severity` and no notification decision. A test performs all five comparisons against one search result, which is this task's central obligation.

**Two things called conflict, kept apart** (D-333). `confidence = CONFLICTED` is a statement about one record — it holds evidence pointing both ways. `CONTRADICTS` is a link somebody stored between two Problems with a required reason. A link does not change either Problem's confidence, and a `CONFLICTED` Problem with no link recorded gets none invented. All four combinations occur, all four are distinguishable, and no derived `hasConflict` marker was added beside a fact the confidence already states.

**The subject is here because a difference needs two sides** (D-334). A search result carries the candidate's conditions and evidence but not its symptoms, and symptom difference is one of the five. Returning only the other Memory's symptoms would be half a subtraction. So `conflict.subject` carries exactly what the rest of the result lacks — `symptoms`, `problemDomain`, `suspectedBoundary`, `status`, `fixKind` — and nothing the ranking view or the revalidation context already owns.

**The other Memory is a snapshot, not a search result** (D-335). No rank, no structural score, no position: it was never a candidate here. Nothing recursive either — no dead ends of its own, no conflicts of its own, **one hop and stop** — because a Memory disagreeing with a Memory disagreeing with something else is a graph, with cycles, that none of the five comparisons needs. `requiredChecks` is absent because the four never vary and copying them per item would make a fixed rule look variable; `suppressed` is absent because it is a presentation control, not a fact about the past.

**Only `CONTRADICTS`, and nothing settles anything** (D-336). The other five relation types are not read. `SUPERSEDES` is the interesting refusal: nothing says a later conclusion refers to the same disagreement, so reading it as a resolution would be the server settling an argument by walking a graph. A mistaken link is not withdrawn either — there is no update path and how one is corrected stays undecided — so it comes back as the historical link it is.

**Direction decides which Problem to look up, then stops mattering** (D-337). One row is stored and `CONTRADICTS` reads the same both ways, so the link is found from either end and the other Memory is whichever end the candidate is not. `fromId`, `toId`, `relationId` and `relationType` do not travel. Every link comes back — no cap, no merging by pair, no de-duplication by wording, ordered by when it was recorded with the identifier breaking ties.

**One statement, because the answer is meant to be compared** (D-338). Candidate, links, counterpart Problems, counterpart Environments and counterpart Verifications from one snapshot: read across several statements, two halves of a comparison could come from two moments and a reader could see a difference that never existed. It settles a race for free — deleting a Problem removes its Relations first in the same transaction, so a link whose counterpart is deleted cannot be observed within one snapshot. Owner and read control at both ends; a link is not permission to read the Problem at its far end.

**A disagreement never costs a Memory its place** (D-339). Nothing dropped, demoted or reordered for being contested, and P4-08 is untouched. The contrast with dead ends is the argument: the specification lists 検索順位調整 among what a dead end is for and lists nothing of the kind for conflicts. A link says two Memories disagree, not which is wrong, and the other end may itself be `INVALID`. When a counterpart becomes unreadable that one contradiction goes and the candidate stays.

**Fresh on every search, stored nowhere, finished before anything is kept** (D-340). A Relation between two *candidates* moves nothing the cache key watches — that key is built from the Problem being worked on — and neither does a counterpart's confidence change or a Verification appended to it. Three tests append each between two searches and require the cache-hit search to show it with the provider and reranker still at one call each. A read failure raises rather than reporting empty contradictions, and travels as itself rather than through the usage-log reporter.

**Eighty-one mutations, each killed by a named test or guard** — fifty-two on behaviour and twenty-nine injecting a forbidden construct, both sets finished before the commit rather than after: every relation type read as a disagreement, a similarity or a supersession read as one, only one end of a link found, the far end taken as the stored target or as the candidate itself, either owner filter or either read control dropped, an unreadable counterpart returned hollow, the reason dropped or rewritten, either side's symptoms dropped or swapped for the other's, either side's conditions or checks dropped or swapped, failures filtered out, trust or currency dropped, the link's timestamp stamped at read time, the identifier carried out, the subject removed, the links capped or reversed or merged, the checks reversed, all four request checks disabled, a contested Memory dropped or demoted or reordered, positions unrenumbered or provenance renumbered, the caller's list edited, either earlier enrichment discarded, the stage skipped on a reused search, the cache filled early, a failed read reported as none, a foreign stage composed in — and, injected: a winner, a preferred Memory, a severity score, a notification, a derived marker, a sort by strength, a second graph hop, dead ends or conflicts or the checklist nested in the snapshot, a contradiction count or penalty on ranking, the trust order rearranged, `proposedDirection` or `currentEnvironment` on the request, the ambient process read, the reason sent to be summarised, the filesystem reached, the regenerable profile used as a source, a Relation or Problem write, `EXCLUDED` introduced, the disagreements cached or logged early, the envelope growing an evaluation or a recommendation field, the stored direction exposed, an HTTP surface, a migration. Five behaviour mutations survived a first run: two were unreachable through behaviour because the composite foreign key already makes a cross-owner link unstorable, and were re-aimed at the guard asserting the predicates textually while the predicates stayed; three were real gaps — a fixture whose counterpart confidence was `HIGH`, the value a stage that stopped reading the column would invent; a link timestamp never checked against anything; and an empty-list gate proven at the statement but not the service — and all three tests were strengthened. The P4-11 and P4-12 sets were re-run and all seventy still hold.

## What exists now — Retrieval evaluation corpus (P4-14)

A named corpus of nine scenarios, run against a real database through the whole pipeline, with a deliberate wrong answer in every one. Two new test files, no production source, no migration, no dependency, no route.

**It measures; it changes nothing** (D-342). `git diff -- src` is empty, and so are the diffs against `package.json`, `supabase/` and the README. The rule was decided in advance: a fixture grounded in the specification that failed would have stopped the task as a finding, not licensed an edit to production. Nothing needed it, and the rule is why the result means anything.

**What it proves, and what it cannot** (D-343). Given a working keyword signal, a working semantic signal and a structural judgement, the pipeline retrieves across Projects, fuses, reranks, applies the controls, enriches, bounds and reuses as specified. It proves **nothing** about any real embedding or reranking model — there is no vendor, no network and no credential in it — and must never be cited as if it did.

**The oracle sees structure and nothing else** (D-344). It reads the current profile and each candidate's profile from the reranker input, and nothing more: no identifier, no Project, no earlier rank, no knowledge of which scenario a candidate is in. A test judges the same features twice under different labels and requires the same answer. Judgement is by concept from a closed table where anything absent maps to itself, so the table can only create agreement it was told about.

**The cross-technology pair is paraphrased** (D-345). "configuration captured during build" against "settings frozen before the runtime starts", and the same for the conditions and both directions — not one shared word. An oracle built from string equality scores that pair at zero, which is the measurement that made structural judgement a model port in the first place. A baseline test asserts the paraphrasing is real, so a later "simplification" that copies phrases across fails and says why.

**Each channel is load-bearing for exactly one scenario** (D-346). The same-technology Memory is stored under an embedding model *version the search never queries with* — comparing across models is refused, a production rule — so only keyword search can reach it. The cross-technology Memory shares no vocabulary with the query and only the vector channel can reach it. Emptying either channel drops its scenario and nothing else.

**The controls run against the structure on purpose** (D-347). Seven candidates whose structural strength is the exact reverse of the order they should be offered in: the best structural match is the suppressed one, the weakest survivor is the current and trusted one. A pipeline that stopped consulting suppression, currency or trust would produce close to the reverse of the expected list, so the assertion cannot pass by luck. The two candidates cut are the *best* controls in the group, which makes the five-candidate bound its own fact. No comparison anywhere is decided by an identifier.

**Eighteen mutations, all caught by this suite** (D-348): either channel emptied, the structural stage bypassed or inverted, the profile never reaching the judgement, proximity weighed before structure, currency or trust or suppression not weighed, the bound removed, the keyword channel forgetting whose Memory it is, any of the three enrichments omitted, reuse disabled, and the successful or dead-end direction dropped from the compared dimensions. Two needed correcting first, and both are findings: **the bound that applies to a search naming no limit is the default, not the ceiling** — raising `MAX_STRUCTURAL_RERANK_LIMIT` changed nothing observable; and **self-exclusion is applied twice**, at the hybrid stage and again at the rerank stage, so removing either alone leaves the other holding. The redundancy is deliberate and stays; the mutation removes both, which is what the behaviour actually means.

**What the corpus says about the constants, which is little** (D-349). RRF `k = 10`: NOT DISPROVEN, no alternative simulated — nine hand-written cases cannot separate one `k` from another. Five offered candidates: SUPPORTED as a functional bound, with no claim that five is right. Cache TTL and capacity: INSUFFICIENT DATA and no new measurement — the existing unit tests already drive the boundary with an injected clock. Uncapped histories: INSUFFICIENT DATA; seeding a thousand rows would invent a threshold rather than measure one. No precision, recall, F1 or quality score was computed: nine curated fixtures are named behaviour acceptance, not a benchmark.

**The derived successful direction is observed** (D-350). The cross-technology scenario requires `successful_directions` among the dimensions the judgement agreed on, which is direct evidence that the generator's derived material is usable for retrieval comparison. It does not create a contract returning `FIX` or `DISCOVERY` detail in a response, and the gap stays a P4-15 decision.

## What exists now — Successful directions, and Phase 4 end to end (P4-15)

The last gap in the retrieval answer is closed, and the whole path is proved as one continuous run. Three new modules, one new intermediate type, one added field, no migration, no dependency, no route.

**A recorded fix is not a verified one** (D-352). The obvious way to close the gap was to return `FIX` Events the way dead ends return `DEAD_END` Events. It would have been wrong: a `DEAD_END` Event *is* the fact, while a `FIX` Event records only that a fix was tried, and **nothing links it to the Verification that later passed**. A Problem with three fixes and one successful check does not say which fix the check was about — returning all three invents three causal claims, taking the latest assumes the last thing written worked, and choosing by proximity in time turns a coincidence of clocks into a rule. So this stage reads **no Event at all**, and the guard scans all three of its modules rather than only the statement.

**The direction is derived guidance, and says so** (D-353). What can honestly be said comes from the summary generator, which reads the whole canonical history and whose claim already carries a mechanical gate. `successfulDirections` is `readonly string[]` — plain on purpose, because a summary, a result and a timestamp would dress a generator's reading up as something somebody recorded at a moment. It is the one derived field on the envelope, and the asymmetry with `deadEndWarnings` is the difference between what storage can and cannot establish.

**The gate is applied again, freshly** (D-354). The artifact is never rewritten when what it describes changes, so the status and the existence of a passing check are re-read in the same statement as the artifact — with the rule **imported** from the status model rather than restated, so it cannot drift from the one generation enforces. `VERIFIED` is terminal through the supported surface, so this is defence rather than a live path: it makes the answer a property of the read instead of something inherited from a lifecycle rule enforced elsewhere. A test writes a failing state through the storage boundary and requires the directions to stop, while asserting the artifact still names them. An empty list means nothing may currently be offered as a direction that worked; it does not mean no fix was ever tried.

**Derived data does not decide whether a Memory exists** (D-355). The artifact is left-joined: a Memory whose profile has not been generated is kept, with an empty list. Order, count and repeats come from the stored profile unchanged — no sort, no de-duplication, no new cap.

**Five fields, five stages, one added each** (D-356). `ranking`, `revalidation`, `deadEndWarnings`, `successfulDirections`, `conflict`. The new stage runs between dead ends and conflicts on both paths and enters no cache, for the reason three earlier stages give: a status change or a check appended to a candidate moves nothing the cache key watches.

**Phase 4 ends with the retrieval surface still internal** (D-357). The specification's minimum API does list a cross-project similarity search, and that requirement is handed forward rather than cancelled. Publishing a route now would ship a contract no standard composition can answer — no generator, embedding provider or reranker is wired behind the three ports — and would settle how an assistant identifies itself by accident. API 0.4.0 and 27 operations, unchanged.

**Continuity, with nothing seeded in the middle** (D-358). `tests/e2e/phase4.e2e.test.ts` carries one investigation from Project A to Project B in nineteen ordered steps: canonical history over a real socket, artifacts through the production generation service, search through the production composition. The direct artifact upsert P4-14 relied on is forbidden here. Two Memories are seeded and only one has a check that passed, so a single search shows the gate working both ways. Four wordings are kept distinct and each difference asserted: the `FIX` Event's, which never travels as a success; the generator's direction, which does; the `DEAD_END` Event's, which is the warning; and the artifact's paraphrase of it, which is comparison material.

**Fifty mutations, all killed by a named test or guard** — thirty on behaviour and twenty injecting a forbidden construct, both sets finished before the commit. Two needed correcting first: a fixture whose dead-end warnings were already empty, so a mutation dropping them was invisible; and an Event guard that read only the statement, so an Event query injected into the service file survived. The P4-12, P4-13 and P4-14 sets were re-run and all hold.

## What is deliberately absent

Do not assume these exist, and do not add them outside the phase that owns them.

- Nothing prevents `VERIFIED` at the database level. The rule is enforced by the transition service, which is the only path that writes status
- No way to reopen a `VERIFIED` or `CLOSED_UNRESOLVED` Problem, and no way to revise a conclusion or a `fix_kind` once one is recorded
- No delete except a Problem's. P3-05 added exactly one destructive operation; there is still no Project, Environment, Event, Verification, Relation or UsageLog delete, no Environment update, no MCP, no AI adapter, no UI
- No concrete summary generator and no concrete embedding provider. Both are ports (D-223, D-241); no vendor SDK or HTTP client is a dependency, and no provider credential exists anywhere. A deployed server therefore still cannot generate artifacts by itself — the orchestration path exists and is proven with scripted ports (D-249)
- No caller of the generation pipeline. Nothing invokes `generateArtifact` in production: no route, no scheduler, no backfill worker, no adapter. Who calls it, and when, is a later wiring decision (D-249)
- No persistent cache. Reuse is a process-local map with a five-minute life; a restart empties it and that is correct, because it is an optimisation and never a source of truth (D-293). No Redis, no cache table, no distributed invalidation
- No cache of the final ranked list. What is reused is the rerank result, so every ranking control is re-read on every search (D-290)
- No single-flight. Two identical searches arriving at once both run — a recorded limitation, not an oversight (D-297)
- No hit/miss reported to a caller. Reuse is not a product promise, and proving it is the tests' job (D-297)
- No write-path invalidation hooks. Appending an Event already misses because the key is built over the Problem's canonical source; a hook would spread a cache dependency through the Memory core (D-296)
- No importance, status or timestamp anywhere in ranking. Importance has no ranking rule in the specification and is a boolean; `VERIFIED` is already reflected in confidence; currency is the `freshness` field and not a clock (D-284)
- No technology identity beyond a Project's free-form `platform` label, compared case-insensitively and exactly. No manifest parsing, framework detection, synonym table or fuzzy match — `Node.js` and `node` are different technologies to this system (D-279)
- No ranking threshold and no ranking-time removal. Suppressed, invalid, conflicted and structurally-unlike candidates are all returned, last (D-281)
- No presentation cut. One to five candidates come back; showing about three is an adapter's decision (D-287)
- No concrete reranker, and no reranker identity recorded. `StructuralReranker` is a port like the other two; nothing here is persisted, so a `rerankerId` would be a field with no reader (D-266)
- No claim that structural comparison works well. Every test scripts the reranker and proves only the orchestration around it; semantic quality is P4-14's, measured against fixtures (D-265)
- No similarity threshold in reranking. A zero score keeps a candidate at the bottom rather than removing it, because deciding a Memory is not worth offering needs P4-08's information (D-273)
- No suggestion, proposed fix, applied fix or approval. Retrieval returns Memories; turning one into an action belongs to an adapter (D-275)
- No query generation anywhere. A caller supplies the lexical terms and the semantic description separately; nothing extracts, summarises, truncates or rewrites either (D-256)
- No vector index, still: an untyped `vector` cannot carry one and no model is chosen to type a cast index. Exact scan is the implementation, measured feasible at MVP scale; migrations 16 and vector indexes 0 are boundary assertions a hardening task will deliberately update (D-254)
- No model router. One injected provider per deployment is the standing assumption; fallback, selection, cost routing and A/B are all absent, and concurrent-rollout overwrites are an accepted, recorded limitation (D-247)
- No retries around the embedding provider, and no reuse of the Phase 3 retry queue for it. A provider failure is a safe error, and trying again is the caller's decision (D-248)
- No search that changes a Memory. A completed search records that each Memory it surfaced was surfaced, and that is its only write (D-299); no ChangeLog, no Relation, no status move, and nothing generated on demand to satisfy a query (D-230, D-240)
- No judgement about whether a Memory is still true. The server returns what it was recorded under and what to re-check; the current code, environment, versions and specification are the adapter's to establish, and no request field accepts any of them (D-310)
- No interpretation of an Environment snapshot. It is returned exactly as stored — no OS, runtime or version extracted, no schema imposed on arbitrary JSON (D-312)
- No `evidenceRef` resolution. References are returned, never fetched, opened, executed or checked for existence; whether one still points at anything is a question about now (D-313)
- No Event on the retrieval path. Evidence stops at Verifications so that dead-end semantics stay with the task that owns them (D-313)
- No revalidation state stored or cached. The historical context is read fresh on every search, hit or miss, because a Verification added to a candidate moves nothing the cache key watches (D-317)
- No automatic `REFERENCED`, `ADOPTED`, `EXCLUDED` or `CHANGED_STRATEGY`. A search cannot observe any of them; a candidate dropped by a stage is not one an AI set aside (D-299)
- No aggregate use counters anywhere. The usage rows are the event source; a count kept beside them would be a second answer that eventually disagrees (D-308)
- No idempotency key on a usage log, and no third queued write kind. The retry queue replays writes that carry a key, and a replayed usage row would be a second record of one search (D-306)
- No morphological analysis. `pgroonga`, `pg_trgm` and `unaccent` are available on the server and deliberately not installed; Japanese sentences are one lexeme to the built-in parser (D-239)
- No query language of this system's own, and no term extraction, OR-relaxation or query expansion — ordinary terms are joined with AND and that is left visible (D-236)
- No HTTP surface for artifacts or for generation. No route, no OpenAPI operation, no debug endpoint — generation is background work, and an artifact is a rendering nobody asked for by name (D-216, D-228). The *search* is published as of P5-02c-impl-1, and it is the only way any of this reaches a caller: API 0.5.0 with 28 operations (D-420)
- No claim that a summary is true. Structure, bounds, the success-claim evidence gate, privacy and source consistency are checked; a well-formed summary of a version nobody mentioned passes all of them. Semantic quality is P4-14's, measured against fixtures (D-228)
- No link from a `FIX` Event to a Verification, and nothing that invents one (D-221)
- No way to tell a close-review Event from an ordinary one. No marker exists, and nothing guesses from authorship or timing (D-221)
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

## What was decided — the Claude Code connection (P5-01)

P5-01 was a read-only audit of what the assistant officially offers today, and it produced decisions rather than code. Nothing in `src/`, `tests/`, `db/`, `docs/` or the package manifest changed.

**The frozen shape.** The user keeps their ordinary interactive session; nothing wraps or replaces it (D-361). The Memory reaches it through a **user-scoped local stdio MCP adapter** — configured once, applying in every project, leaving every repository untouched (D-362). The chain is assistant → stdio MCP → assistant-specific adapter → common Memory JSON API client → vendor-independent Memory Server, and the adapter may not import the core directly (D-363).

**The three roles.** Hooks carry deterministic lifecycle facts. Skills carry judgement and reusable guidance, and are never a transport. A plugin is packaging, decided when there is something to package rather than now (D-366, D-369). Skill bodies are written to the portable open format so a second assistant reads the same file, with host-specific configuration pushed out to the packaging layer (D-367).

**What is available and whose question it is.** The project root and the set of directories in scope are supplied natively, and P5-03 owns what to do with them (D-364). A session identifier is available through hooks and identifies a conversation, never a Problem; nothing assumes it arrives with a tool call (D-365). Whether a session-start hook can reach the adapter depends on connection ordering that is not documented, so P5-04 measures it rather than assuming (D-375).

**Credentials.** The Memory credential lives in the user's local environment, reaches the adapter as process environment, and is presented as an authorization header. It goes into no repository, no `CLAUDE.md`, no `SKILL.md`, no Memory content and no tool argument (D-374).

**Not depended on:** preview features, delegation as a transport, deferred tool loading as a precondition, and any programmatic wrapper of the interactive session (D-370, D-373, D-361).

**Transient, and deliberately not a Decision.** The audit found the local assistant installation broken — the launcher pointed at an executable that was not there, left behind by an update that reported success without replacing it. **A readiness preflight has since been run and the installation is in a supported working state again**, through the officially supported reinstall and nothing else. The standing operational habit is what remains: before an integration run, check that the ordinary `claude --version` succeeds, since the same failure can recur silently. No version number, path or repair step is recorded as an invariant, and neither is the event catalogue, the command list, current flags, preview syntax or timeout defaults (D-377). Those are looked up fresh from the official documentation whenever they are needed.

## What exists now — the adapter boundary and the common client (P5-02a)

**Two private workspace packages, and the server did not move.** `packages/memory-api-client/` speaks the Memory JSON API; `packages/claude-code-adapter/` holds what is particular to this host. `src/`, `tests/` and `supabase/` are exactly where they were, because moving four completed phases to make room for two packages that needed none of it would have rewritten several hundred imports and every path-reading guard (D-381).

**The dependency direction, declared rather than described.** The server keeps its three runtime dependencies; the client has none at all; the adapter has one, the client. A guard reads all three from the manifests, because a package that does not declare a dependency cannot import it — and scans the sources as well, because npm hoists and a relative import can escape a package without naming anything (D-389).

**The client.** `createMemoryApiClient({ baseUrl?, credential, fetch?, timeoutMs? })`, the platform's `fetch`, and one method: `getProblem` (D-382, D-383). It returns the wire shape unchanged rather than a second domain model, and validates what arrives rather than trusting a type annotation. Failures come in three kinds — refused, unreachable, unreadable — and no message carries a value that caused it, not the base URL, not the body, not the server's own message, not the transport error and not a `cause` (D-384). No retries at all, and a deadline so nothing hangs (D-385). The credential is presented as a bearer token and appears nowhere else, including in anything the client can be serialised into (D-386).

**The adapter.** `createClaudeCodeMemoryClient(env?, fetch?)` reads `MEMORY_API_TOKEN` and `MEMORY_API_URL` and returns a client. It applies one rule of its own — whether the credential variable is set — and leaves what the values mean to the client (D-387). `CLAUDE_CODE_SOURCE_AI` is `'claude-code'`, with no version, session or path in it, and the model never supplies it.

**What is deliberately absent.** No Search route and no API version change: every search channel reads a retrieval artifact, production generates none, and a route published now would answer correctly and uselessly (D-379). No provider stub standing in for one. No MCP dependency and no protocol code, so no SDK version is pinned against code that does not exist (D-388). No `bin`, no stdio bootstrap, no empty server. No project detection, no session handling, no hook, skill or plugin.

## What exists now — the artifact lifecycle (P5-02b-impl-1)

**The invariant.** A searchable artifact describes the current canonical source, or it does not exist (D-393). Every write that changes what a summary is generated from — an Event, a Verification, a canonical Problem field, a status, a conclusion — removes the stored artifact inside its own transaction, as a second statement rather than a CTE, because a CTE's snapshot cannot see an artifact committed while the write waited on the generation gate's lock — measured, and the reason the design moved (D-395). Replays, version conflicts and refused moves invalidate nothing (D-397); the read control gates visibility, never content (D-398); artifact staleness is not the Memory's `freshness` (D-393).

**The gates.** Every artifact-backed read — lexical, vector, structural material, successful directions — accepts only fingerprints from the current source schema, as a bound-parameter `starts_with` with the separator included. Hard for source changes, soft for provider changes: an artifact from an outdated generation stack keeps serving the channels that can read it until regeneration replaces it (D-394).

**The maintenance layer, vendor-neutral and unwired.** `RetrievalGenerationProfile` says which stack is current; one bounded reconciliation statement finds missing, schema-incompatible and profile-outdated artifacts over existing columns, with no migration, no dirty flag and no job table — absence is the only dirty state (D-399). A coordinator does single-flight per Problem, one pending bit for bursts, and a bounded pool (D-401). The write services ring an optional `RetrievalArtifactMaintenance` doorbell after commit; nothing stands behind it yet (D-402). Correctness never waits for any of this (D-400).

**Handed to P5-02b-impl-2, by name.** The concrete providers, their configuration and credential, the startup and interval wiring of the sweep, and the per-owner dispatcher behind the doorbell. P5-02c stays behind that (D-403).

## What exists now — the OpenAI provider adapters (P5-02b-impl-2a)

**The three ports have production implementations**, all under `src/providers/openai/`, and the vendor's name appears nowhere else in `src/` — a guard reads that (D-404). Generative calls use `gpt-5.6-terra` on the Responses API with strict structured outputs; embeddings use `text-embedding-3-large` at 1024 dimensions. Both are code constants, not knobs: changing a model is a visible identity change that reconciliation turns into regeneration (D-405). OpenAI publishes no dated snapshots, so the alias is the identity and its limits are recorded rather than papered over (D-406); the generator id carries the model, the generator version (`retrieval-summary-v1`) carries this repo's prompt/schema contract (D-407).

**One fixed host, one credential.** The transport posts to the official endpoint as a constant with no way to move it; `OPENAI_API_KEY` is read in exactly one file, appears only in the authorization header, and its absence means the retrieval stack is disabled — never a startup failure (D-408). Native fetch, no SDK, zero hidden retries, a named-constant timeout (D-409).

**The trust boundary did not move.** Strict schemas make well-formed answers the cheap case; the domain validators remain the authorities, refusals and incomplete responses are refused by kind, and there is no prose fallback (D-410). What travels is minimal: the fingerprinted source, the verbatim summary, features under per-call opaque keys — never a Problem UUID, never ranking material, never an instruction channel a caller byte can reach (D-411). Sending Memory content to the configured provider is named plainly in `docs/retrieval.md` (D-412).

## What exists now — the production retrieval runtime (P5-02b-impl-2b)

**A standard `npm start` server now runs the whole supply side** when `OPENAI_API_KEY` is set: canonical write → atomic invalidation → post-commit doorbell → owner-scoped background generation through the configured providers → locked fingerprint gate → stored artifact, with a startup sweep as automatic backfill and a periodic sweep as crash and outage recovery. Without the credential, the capability is disabled and nothing else changes — CRUD runs, `/health` keeps its meaning, no timer, no owner scan, no outbound request, and the startup summary says `retrieval-generation=DISABLED` (D-414).

**The boundaries held.** The composition root imports one vendor-neutral boundary (`src/providers/index.ts`) and never a vendor name (D-413). The runtime (`src/runtime/retrieval-runtime.ts`) is vendor-neutral and owner-honest: cross-owner discovery returns identifiers only, every context is resolved through `resolveOwnerContextFor` with casts guarded off, and every read below is owner-scoped (D-415). Owner stacks are lazy, cached, and evicted on failed builds; a process-wide semaphore holds generation to one at a time across owners (D-416). Sweeps run after the listener, are never awaited, never overlap, and contain their failures as closed words (D-417). `stop()` clears the timer, refuses new work, and shutdown waits for no provider (D-418).

## What exists now — the Search JSON API (P5-02c-impl-1)

**One route, and it is the demand side of the whole phase.** `POST /v1/problems/:problem_id/search` takes four fields — `source_ai`, `lexical_text`, `semantic_text`, `current_features` — and returns candidates with the material to judge them. It hangs off the Problem being worked on because that Problem *is* the search context, and a guard requires exactly one search path and one method in all of `src/` (D-420). API 0.5.0, 28 operations, `Search` tag, `operationId: searchProblemMemory`.

**The refusals are the design** (D-421). No owner or client, no Project, no limit of any kind, no embedding or vector, no model, provider or cache instruction, no recommendation or action. Unknown fields are a 400 rather than a silent drop. `current_features` is the domain's eight-field profile built from the domain's own constants, with the version pinned to an exact enum; `parseStructuralFeatures` remains the trust boundary and the schema is the transport boundary, and both stay.

**Three outcomes are ordinary 200s; one is the ordinary 404** (D-422). Zero candidates, reading turned off and a Problem that moved mid-search are answers, not faults. A Problem this owner cannot read is the same 404 as one that never existed. No 409 — a search writes nothing to the Problem. A refused search reuses the existing application-rejection branch for its 400; a broken pipeline stays a 500.

**Two schemas were tightened to match what the server sends** (D-430). `required_checks` gained `minItems` / `maxItems` / `uniqueItems`, so the contract says "all four" instead of permitting none; `verification_type` is closed against `VERIFICATION_TYPES` instead of being free text. Neither is a version change — nothing was added, removed or renamed.

**Material, never an answer** (D-423). Every field of all five kinds travels, written out by hand rather than spread, with nothing sorted, deduplicated, truncated or renumbered and `structural_score` null rather than zero when nothing scored it. No recommendation, verdict, winner, should-retry, cache hit or provider identity anywhere in the nested schema — a contract test sweeps the serialised whole for each word.

**A missing provider is a smaller answer, not a missing route** (D-424). Both ports are optional at the two stage services; with neither configured the lexical channel answers, the two statuses name themselves, and a database-backed test proves the platform `fetch` is never called. No stand-in provider exists anywhere in `src/`, and a guard scans for one by name.

**A provider failure says which of three things happened** (D-428, added by the formal review). `UNAVAILABLE` — unreachable, timed out, rate limited, server error — degrades the channel and the search answers. `INVALID_RESPONSE` and `UPSTREAM_REJECTED_REQUEST` are integration failures: they leave the stage services, become a 500, and are never converted into a complaint about the caller's query. The translation from any vendor's own words happens once, at `src/providers/openai/failure.ts`, which is the last place an HTTP status exists; the classified error carries the kind and nothing else. The P4 contract is intact — a port that throws a plain `Error` still degrades — and the production matrix is driven through the real transport (D-429).

**Transport asks for a service and never assembles one** (D-425). `RetrievalSearchServiceResolver` is the seam; `src/http/` still holds no pool and no repository, and only `src/index.ts` knows both the runtime and the transport. The owner comes from `context.repository.ownerId`, is cross-checked against the artifact repository's, and is resolved through `resolveOwnerContextFor` — never cast. The service graph is request-scoped because the usage-log writer inside it belongs to that request; the rerank cache is process-wide because the owner is inside its key. The resolver is a *required* dependency of `buildMemoryHttpApp`, so a wiring slip cannot quietly shrink the contract.

**One usage row per Memory offered, and a closed report when one is lost** (D-426). The route writes nothing itself. The failure reporter may pass on `event`, `kind` and `attemptedRows` and nothing else, under the new closed event `SEARCH_USAGE_LOG_WRITE_FAILED` — the only log event that reports a partial success.

## What exists now — the common client's search (P5-02c-impl-2)

**`search(problemId, request)`, and the client now has two methods.** It sends the four fields exactly as the contract names them, `snake_case` in and `snake_case` out, and returns what came back unchanged — no renaming, no dates parsed, no sorting, no de-duplication, no ranks renumbered (D-433, D-435).

**The contract is mirrored, and the mirror is joined in the server's suite** (D-432). Every closed set, bound and field list is written from the published contract, nothing in the package reaches `src/`, and `tests/packages/api-client-contract.test.ts` compares each copy against both the domain constants and the route schemas the OpenAPI document is generated from.

**Four outcomes returned, everything else raised** (D-434). The server's three, plus the client's naming of a `404 NOT_FOUND` as `CURRENT_PROBLEM_NOT_AVAILABLE` — that exact pairing only, so a 404-shaped answer from anything else stays a protocol failure or an ordinary refusal. A `500` stays a refusal: it may mean the server's provider integration is broken, and re-reading it as an empty result would erase the signal.

**Validated to the leaf, refused rather than repaired** (D-433, D-435). Exact key sets on every nested object, closed enums, ranks as whole numbers from one, nullable fields present-and-null rather than absent, `required_checks` four-with-no-repeats. A `200` that is not one of the three outcomes is the new `SEARCH_RESPONSE_MALFORMED`, and the body that could not be read is not attached to it.

**A search waits longer than a read, and one knob still beats both** (D-436). The ordinary constant keeps its name, value and meaning; a search has its own longer finite default, because a cold search runs two provider calls in series behind the server. An explicit `timeoutMs` overrides every operation, and no second knob was added.

**One call, one request; no judgement, no fallback** (D-437). Nothing retried, ever. An unreachable Memory raises rather than returning an empty result, `CURRENT_SOURCE_CHANGED` does not trigger a second search, and `source_ai` is passed through as the caller wrote it.

**The Claude adapter is unchanged** (D-438). It returns the client it built, so the method arrived for free — and a guard checks it did not also grow policy about when to search or what to call itself.

## Immediate objective

P5-03 — Project auto-detection.

P5-02 is **complete**: implemented, formally reviewed, and its two review findings
corrected. An assistant can now reach the whole Memory — including the search —
through the common client.

P5-03 is **NOT STARTED**.

Notes for whoever picks this up:
- **The retrieval path is finished end to end** — write → invalidation → generation → artifact → search → HTTP → client. Read D-393 to D-438 before touching any of it
- **The specification's minimum API is fully routed and reachable.** The cross-project similarity search was the last item without a route (D-357, D-376, D-420), and the client can call it (D-433)
- **What P5-03 must not take on.** When to search, what `source_ai` to send, how to present a result, and how to carry on when the Memory is unavailable are all later tasks with their own decisions (D-437, D-438). The adapter deliberately holds none of them today, and a guard says so
- **An adapter must not import the internal service** (D-363), and the common client must stay free of any assistant, host or protocol (D-382). Both are guarded in `tests/packages/boundary.test.ts`
- **Check the host before building anything** (D-371), and use the lightest mechanism that is actually sufficient (D-372). Look details up fresh from the official documentation rather than from anything recorded here
- `docs/retrieval.md` is the public account of what a search returns and what the server deliberately does not decide — including what happens to a rendering when the record changes, and what the maintenance loop now does automatically
- **Before an integration run, check that the ordinary `claude --version` succeeds.** The readiness preflight has been done once; the failure it fixed was a silent one and can recur

## Core MVP milestone

The Core MVP is not complete until the Phase 7 cross-project E2E succeeds: Project A experience is stored, a structurally similar problem in Project B automatically retrieves the relevant Memory, current conditions are revalidated, and the Memory meaningfully informs the new investigation.
