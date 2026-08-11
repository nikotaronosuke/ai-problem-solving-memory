# TODO

Updated: 2026-08-11

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

### P1-03 — NEXT implementation task
Supabase / PostgreSQL connection and migration foundation. Not started.

Note: `.env.example` currently documents `DATABASE_URL` as a commented placeholder only. Nothing in the code reads it yet.

### P1-04 onward
Proceed only after dependencies and each task's Definition of Done are satisfied.

Phase 1 order:
`P1-01 → P1-02 → P1-03 → P1-04/P1-05 → P1-06 → P1-07 → P1-08 → P1-09/P1-10 → P1-11 → P1-12 → P1-13 → P1-14`

## BLOCKED

None currently documented.

## LATER

Implementation Phases 2–9 are already broken down in the private specification repository. Do not begin them before Phase 1 Definition of Done is satisfied unless the specification is deliberately revised.
