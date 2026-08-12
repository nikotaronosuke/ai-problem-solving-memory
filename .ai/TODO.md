# TODO

Updated: 2026-08-12

This is the working list, not a history. What was done in Phase 1 lives in git history, `.ai/DECISIONS.md` and the summary in `.ai/CURRENT.md`.

## NOW — Implementation Phase 2

Follow the private task breakdown:
`nikotaronosuke/ai-problem-solving-memory-spec/docs/implementation/phase2-task-breakdown.md`

Implementation Phase 1 is complete. All fourteen tasks are done and its Definition of Done was verified item by item.

### P2-01 — NEXT
API application foundation.

- HTTP/JSON API foundation for the Memory Server
- request validation, error mapping, auth context and logging as a shared layer
- domain service separated from the transport layer
- initial API versioning policy

Definition of Done:
- a health endpoint and an authenticated endpoint work
- invalid input returns a consistent error shape
- the transport layer does not access the database directly

Depends on Phase 1, which is satisfied.

## BLOCKED

None currently documented.

## SETTLED — local stack network exposure

Docker publishes the local Supabase ports on all interfaces, not only loopback. Enabling fewer services reduced the published ports to three, but the binding address is a Docker daemon setting, not a repository one.

Decided: not a blocker. The Docker daemon configuration is left unchanged, and the operating rule is to stop the local stack when it is not in use (`npm run supabase:stop`). Revisit only if the stack ever needs to run on an untrusted network.

## LATER

P2-02 onward follow the private Phase 2 breakdown. Phases 3–9 follow the roadmap in the private specification repository. Do not begin a later phase before the current one's Definition of Done is satisfied unless the specification is deliberately revised.
