# TODO

Updated: 2026-08-13

This is the working list, not a history. What was done in Phase 1 lives in git history, `.ai/DECISIONS.md` and the summary in `.ai/CURRENT.md`.

## NOW — Implementation Phase 2

Follow the private task breakdown:
`nikotaronosuke/ai-problem-solving-memory-spec/docs/implementation/phase2-task-breakdown.md`

Implementation Phase 1 is complete. All fourteen tasks are done and its Definition of Done was verified item by item.

### P2-01 — DONE
API application foundation.

Fastify 5 transport in `src/http/`, application services in `src/app/`, `/v1` versioning with `/health` outside it, one error envelope, owner-scoped authenticated request context, redacted logging, and a composition root that owns the pool, the listener and shutdown.

Definition of Done verified: `/health` and `/v1/me` work, invalid input returns a consistent `INVALID_REQUEST` envelope, and the transport layer imports neither `pg` nor `src/db/` — enforced by `tests/architecture.test.ts`, not convention.

### P2-02 — DONE
Project / Environment API.

Seven routes in the authenticated `/v1` scope: Project create, get, list and partial update; Environment create, get and list. Environments are nested under their project for create and list. No delete, and no Environment update.

Definition of Done verified against a real database: an owner creates, reads, lists and patches its own projects and environments; another owner gets 404 for each of read, patch, environment-create and environment-list, with a body identical to a resource that does not exist; patching an unknown id creates nothing; and transport reaches storage only through the application service, enforced by the architecture test.

Repository grew from ten operations to thirteen: `listProjects`, `updateProject`, `listEnvironments`.

### P2-03 — DONE
Problem create / get / list / partial update API.

Four routes: `POST|GET /v1/projects/:project_id/problems` and `GET|PATCH /v1/problems/:problem_id`. No delete, and no unscoped `/v1/problems` collection.

Definition of Done verified against a real database: an owner creates, reads, lists and patches its own problems; another owner gets 404 for read, patch and list, with a body identical to a resource that does not exist; patching an unknown id creates nothing; and every error uses the shared envelope.

Which fields a caller may set was decided here (D-054, D-055). A new Problem's starting state comes from the column defaults, and a patch may change eleven fields — `status`, `fix_kind` and `version` are not among them, because they belong to P2-06, P2-12 and P2-07 respectively. Sending one is a 400 rather than an ignored field.

Repository grew from thirteen operations to fifteen: `listProblems`, `updateProblem`.

### P2-04 — DONE
Event append / list API.

Two routes: `POST|GET /v1/problems/:problem_id/events`. No single-event read, no update, no delete.

Definition of Done verified against a real database: the same `client_event_id` sent again does not produce a second event, and a `HYPOTHESIS → ATTEMPT → DEAD_END → DISCOVERY → FIX` history appends and reads back in order.

The open question D-027 left is now settled (D-058): a retry returns the original event with the same 201 and the same body, the first write wins even if the retry's payload differs, and the key is the owner's rather than the problem's. The race is arbitrated by the unique index rather than by a read-then-write, and the concurrency test was confirmed to fail against the naive version before being kept.

Repository operations unchanged at fifteen — `appendEvent` and `listEvents` already existed.

### P2-05 — DONE
Verification append / list API.

Two routes: `POST|GET /v1/problems/:problem_id/verifications`. No single-verification read, no update, no delete, and no route reaching one through an Event.

Definition of Done verified against a real database: a FIX Event and a Verification are stored and read back as separate things, and successful and failed checks are distinguishable — `result` is a boolean at the HTTP boundary as well as in storage, with `null`, `"true"`, `1` and a missing field all refused rather than coerced.

The question D-060 deferred is now answered (D-063): a Verification retry replays the original and cannot change what the check found, in either direction. `DuplicateClientEventIdError` had no remaining thrower once both paths replayed, so it was removed rather than kept (D-064). Recording a successful Verification still leaves the Problem's status untouched (D-065).

Repository operations unchanged at fifteen — `appendVerification` and `listVerifications` already existed.

### P2-06 — DONE
Problem state transition service.

One route: `POST /v1/problems/:problem_id/status-transitions`, taking only `target_status`. It is the only way a status changes — the Problem PATCH still refuses `status`, and no append moves it.

Definition of Done verified against a real database: `VERIFIED` is unreachable without a successful Verification of the Problem's own, every move outside the matrix is refused, and a paused Problem resumes as either working status.

The rule itself is `src/domain/problem-status.ts` — plain data and plain functions, no HTTP, no storage. All 25 status pairs are checked against a matrix written out independently of the implementation, so an added or removed move is visible. The architecture test now also forbids a status literal anywhere in `src/` outside the domain.

A transition changes the status and nothing else: `fix_kind`, `confidence`, the flags and `version` all stay put, and a refusal writes nothing at all (D-069).

Repository grew from fifteen operations to sixteen: `updateProblemStatus`, deliberately separate from `updateProblem` whose input still has no status field.

### P2-07 — DONE
Optimistic locking on Problem.

`expected_version` is required on both Problem write paths — the ordinary PATCH and the status transition — and both increment the version on success and share the one column, so an edit and a transition conflict with each other rather than passing unseen.

Definition of Done verified against a real database: two writes from the same version leave one 200 and one 409, and Event and Verification appends keep working independently of the Problem's version. The three racing tests were confirmed to fail against a read-then-write first, where all three produce two 200s and a lost update.

`VERSION_CONFLICT` is a fifth error code at 409, naming no version (D-074). Ownership is settled before the version, and the version before the transition rule (D-075).

Events and Verifications are deliberately not versioned: their retry protection is `client_event_id`, which answers a different question (D-072).

Repository operations unchanged at sixteen — both write signatures gained `expectedVersion` rather than a new operation appearing.

### P2-08 — DONE
Relation entity / API.

A tenth migration adds the `relation_type` DOMAIN and the `relations` table; two routes follow: `POST|GET /v1/problems/:problem_id/relations`. Create and list only.

Definition of Done verified against a real database: a link cannot cross owners, cannot point at a Problem that does not exist, and cannot join a Problem to itself — each refused by the application and, for the last two, by the database as well.

Links may cross projects, which is the point (D-078). One row per link, both ends listed, rows reported as stored (D-077). A Relation does not touch either Problem and carries no evidence across — a Problem linked to a `VERIFIED` one still needs its own successful Verification (D-079).

Schema counts moved as expected: migrations 9 → 10, tables 6 → 7, DOMAINs 6 → 7, foreign keys 5 → 7, all still RESTRICT, still no native enum and no trigger. The exact-count tests were updated to the new figures while keeping the existing constraints asserted.

Repository grew from sixteen operations to eighteen: `createRelation`, `listRelations`.

### P2-09 — DONE
UsageLog.

An eleventh migration adds the `usage_action` DOMAIN and the `usage_logs` table; two routes follow: `POST|GET /v1/problems/:problem_id/usage-logs`. Create and list only.

Definition of Done verified against a real database: usage is recorded independently of the Memory itself — neither Problem changes — and which AI used what is traceable through `source_ai`, `action`, `memory_id` and `reason`.

It stayed explicit rather than becoming a read side effect (D-084), which was the question this task had to answer first. `source_ai` describes and never authorises (D-085). Cross-project usage is allowed and cross-owner refused, both ends checked. A Problem may be its own memory, unlike a Relation, because continuing an investigation under a different AI is real.

Global Audit stayed out (D-081): no tool, model or approval columns, and no audit route.

Schema counts moved as expected: migrations 10 → 11, tables 7 → 8, DOMAINs 7 → 8, foreign keys 7 → 9, all still RESTRICT, still no native enum and no trigger.

Repository grew from eighteen operations to twenty: `createUsageLog`, `listUsageLogs`.

### P2-10 — DONE
ChangeLog.

A twelfth migration adds the `change_logs` table; one route follows: `GET /v1/problems/:problem_id/change-logs`. Reading only — entries are written by the two mutating services, never by a caller.

Definition of Done verified against a real database: who changed what, when, and how is readable from the history, and the before/after policy does not contradict the secrecy requirement — free text is described rather than copied, checked by writing distinctive strings and asserting they appear nowhere in the stored `changes`.

The change and its record are one transaction (D-088). This is what the `DatabaseExecutor` seam was shaped for, and `src/db/transaction.ts` is the runner. Both rollback tests were confirmed to fail against a non-transactional context before being kept.

`changed_by` is now required on both Problem write paths, and is descriptive rather than authorising (D-091). One entry per mutation, bracketed by versions, with a unique constraint per `(owner, problem, to_version)` (D-089). Refused mutations record nothing.

Schema counts moved as expected: migrations 11 → 12, tables 8 → 9, foreign keys 9 → 10, all still RESTRICT. No new DOMAIN, still no native enum and no trigger.

Repository grew from twenty operations to twenty-two: `createChangeLog`, `listChangeLogs`.

### P2-11 — DONE
Memory control API.

One route: `PATCH /v1/problems/:problem_id/memory-control`, taking `expected_version`, `changed_by` and at least one control. No migration, no new column, no new repository operation.

Definition of Done verified against a real database: `memory_read_enabled=false` and `memory_write_enabled=false` are settable through the API, and suppression is not confused with `INVALID` — every test that sets one control asserts the other three did not move (D-094).

`invalidate: true` sets `freshness` to `INVALID` and nothing else; `invalidate: false` and `freshness` are both refused, because restoring a guessed freshness would overwrite a real distinction (D-095).

Basic modification remains the ordinary Problem update, which still accepts these fields (D-092). Both surfaces go through one extracted mutation path, so the locking, transaction and history cannot drift (D-093).

The controls are not authorisation and are not enforced yet: turning everything off leaves every read working and the controls reachable, and no endpoint starts refusing writes on the strength of a flag (D-096).

Schema and repository counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT, 22 repository operations.

### P2-12 — DONE
Problem close/review API.

One route: `POST /v1/problems/:problem_id/close`, taking `expected_version`, `changed_by`, a `target_status` limited to the three conclusions, an optional `fix_kind` and four optional review summaries. No migration and no new column.

It was made a separate surface rather than metadata on a transition (D-097). The transition matrix and the `VERIFIED` gate were not re-litigated: close calls the same domain decision and the same evidence check, so a high-level surface cannot become a way around either (D-098). Working statuses are refused here.

`fix_kind` is finally written, here and nowhere else in this phase — absent leaves it, `null` clears it, and it stays a separate axis from status in both directions (D-099). The review summaries become ordinary Events in the existing vocabulary rather than a Review resource or new event types (D-100). Status, fix kind, the Events and the change log entry commit together in one transaction and one version step, verified by breaking each write in turn (D-101).

Two things surfaced while doing it. `appendEvent` used to recover from a duplicate `client_event_id` by catching the error and re-reading, which aborts an enclosing transaction; it now uses `on conflict … do nothing returning`, with P2-04's idempotency and concurrency tests re-run against the change. And Events written in one transaction share a `created_at`, so the four review Events have no order among themselves — accepted rather than fixed, since each carries its own type (D-102).

Schema counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT. Repository grew from twenty-two operations to twenty-three: `updateProblemConclusion`.

### P2-13 — DONE
API contract / schema documentation.

One route: `GET /openapi.json`, outside `/v1` and unauthenticated. One new runtime dependency, `@fastify/swagger` in dynamic mode. No migration, no new repository operation, no business behaviour changed.

The route schemas stay the only contract. Generation reads what Fastify already validates and serialises through, so the document cannot describe something the server does not enforce (D-103). Nothing generated is committed, so there is no second artefact to update (D-104). OpenAPI 3.1, because the runtime schemas are plain JSON Schema and 3.0 would have required rewriting live validation into its `nullable` dialect (D-105).

Definition of Done verified against the generated document rather than the source: exactly 25 operations with unique stable operationIds (D-108), every enum set, required field, `minProperties` and `additionalProperties: false` intact, the five error codes, and `GET /openapi.json` byte-identical to `app.swagger()`. 70 tests, and a route schema loosened by accident fails them (D-111).

One real finding while implementing it. `register` is deferred, so the generator's `onRoute` hook does not exist until `ready()` — a route added directly to the instance before then is silently absent from the document. `/health` was missing for exactly that reason. Every route now goes through a queued plugin, and the inventory test is what caught it (D-106).

No security scheme is declared, because no client credential contract exists yet (D-110). No Swagger UI (D-109).

Schema and repository counts unchanged: migrations 12, tables 9, DOMAINs 8, FKs 10 all RESTRICT, 23 repository operations. Runtime dependencies 2 → 3.

### P2-14 — NEXT
Phase 2 E2E.

Depends on P2-02 through P2-12, all satisfied. See the private task breakdown for the required flow and negative cases.

Every step and every refusal is already covered per-endpoint, so the value is in the sequence: state carried from one step to the next against one database, which is where an ordering assumption or a leaked identifier would show. A suite that re-runs the existing assertions back to back would add coverage numbers and nothing else. `tests/integration/phase1.integration.test.ts` is the shape to follow, one layer up. Satisfying Phase 2's Definition of Done is what this closes out.

## BLOCKED

None currently documented.

## SETTLED — local stack network exposure

Docker publishes the local Supabase ports on all interfaces, not only loopback. Enabling fewer services reduced the published ports to three, but the binding address is a Docker daemon setting, not a repository one.

Decided: not a blocker. The Docker daemon configuration is left unchanged, and the operating rule is to stop the local stack when it is not in use (`npm run supabase:stop`). Revisit only if the stack ever needs to run on an untrusted network.

## LATER

P2-02 onward follow the private Phase 2 breakdown. Phases 3–9 follow the roadmap in the private specification repository. Do not begin a later phase before the current one's Definition of Done is satisfied unless the specification is deliberately revised.
