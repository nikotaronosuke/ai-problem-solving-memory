# TODO

Updated: 2026-08-12

This is the working list, not a history. What was done in Phase 1 lives in git history, `.ai/DECISIONS.md` and the summary in `.ai/CURRENT.md`.

## NOW — Implementation Phase 2

Follow the private task breakdown:
`nikotaronosuke/ai-problem-solving-memory-spec/docs/implementation/phase2-task-breakdown.md`

Implementation Phase 1 is complete. All fourteen tasks are done and its Definition of Done was verified item by item.

### P2-01 — DONE
API application foundation.

Fastify 5 transport in `src/http/`, application services in `src/app/`, `/v1` versioning with `/health` outside it, one error envelope, owner-scoped authenticated request context, redacted logging, and a composition root that owns the pool, the listener and shutdown.

Definition of Done verified: `/health` and `/v1/me` work, invalid input returns a consistent `INVALID_REQUEST` envelope, and the transport layer imports neither `pg` nor `src/db/` — enforced by `tests/architecture.test.ts`, not convention.

### P2-02 — NEXT
Project / Environment API.

- Project create / get / list / update
- Environment create / get / list
- owner scope enforced on every endpoint

Definition of Done:
- CRUD works within an owner
- another owner's data is unreachable
- destructive operations may stay unimplemented if outside MVP requirements

Depends on P2-01, which is satisfied. Routes go inside the existing `/v1` scope, which already applies the authentication hook. List and update need adding at the repository boundary as well.

## BLOCKED

None currently documented.

## SETTLED — local stack network exposure

Docker publishes the local Supabase ports on all interfaces, not only loopback. Enabling fewer services reduced the published ports to three, but the binding address is a Docker daemon setting, not a repository one.

Decided: not a blocker. The Docker daemon configuration is left unchanged, and the operating rule is to stop the local stack when it is not in use (`npm run supabase:stop`). Revisit only if the stack ever needs to run on an untrusted network.

## LATER

P2-02 onward follow the private Phase 2 breakdown. Phases 3–9 follow the roadmap in the private specification repository. Do not begin a later phase before the current one's Definition of Done is satisfied unless the specification is deliberately revised.
