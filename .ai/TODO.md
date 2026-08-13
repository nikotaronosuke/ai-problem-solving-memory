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

### P2-06 — NEXT
Problem state transition service.

Depends on P2-03, P2-04 and P2-05, all satisfied. Nothing writes `status` today: it is not PATCHable (D-055) and no write moves it as a side effect (D-033, D-065). This task is where that becomes possible, and where `VERIFIED` has to be made to require at least one successful Verification — which is now findable mechanically, since `result` is a boolean the API cannot blur.

## BLOCKED

None currently documented.

## SETTLED — local stack network exposure

Docker publishes the local Supabase ports on all interfaces, not only loopback. Enabling fewer services reduced the published ports to three, but the binding address is a Docker daemon setting, not a repository one.

Decided: not a blocker. The Docker daemon configuration is left unchanged, and the operating rule is to stop the local stack when it is not in use (`npm run supabase:stop`). Revisit only if the stack ever needs to run on an untrusted network.

## LATER

P2-02 onward follow the private Phase 2 breakdown. Phases 3–9 follow the roadmap in the private specification repository. Do not begin a later phase before the current one's Definition of Done is satisfied unless the specification is deliberately revised.
