# CLAUDE.md

## Project
AI Problem-Solving Memory

This public repository is the implementation repository for the **Problem-Solving Memory module**.
It is not the implementation repository for the whole future Personal AI Development OS.

The detailed product specification is intentionally kept in the private repository:
`nikotaronosuke/ai-problem-solving-memory-spec`

Before implementing a phase, read the corresponding private specification and task breakdown. Do not infer missing product requirements from this public file alone.

## Source of truth priority
1. Private `docs/spec/final-mvp-spec.md`
2. Private `docs/spec/mvp-os-boundary-addendum.md` for Personal AI Development OS boundary questions
3. Private `docs/implementation/mvp-roadmap.md`
4. Private `docs/implementation/phaseN-task-breakdown.md`
5. Public `.ai/DECISIONS.md`
6. Existing implementation/tests

If these disagree, stop and resolve the specification conflict before changing behavior.
For OS/module-boundary questions only, the boundary addendum overrides broader wording in the MVP spec.

## Module boundary
This repository implements only the Problem-Solving Memory module.

In scope:
- Problem / Event / Verification / Relation
- Project / Environment
- cross-project Memory retrieval
- AI handoff for the same Problem
- Memory-specific usage/change logs
- Memory-specific privacy, owner boundary and export

Out of scope for this repository:
- global Tool Gateway
- external SaaS credential hub
- global Approval Engine
- Skill Registry
- Workflow / Blueprint Engine
- Model Router
- OS-wide Audit warehouse

Do not pull those responsibilities into the Memory Server as implementation shortcuts.

## Session startup
At the beginning of every implementation session:
1. Read `.ai/CURRENT.md`
2. Read `.ai/DECISIONS.md`
3. Read `.ai/TODO.md`
4. Read the current phase task breakdown from the private spec repository
5. Inspect git status and the relevant implementation/tests

Do not start a later task just because it is easy if an earlier dependency is incomplete.

## Session shutdown
Before reporting completion:
1. Run the tests/typecheck/lint required by the current phase
2. Review git diff/status
3. Update `.ai/CURRENT.md`
4. Update `.ai/TODO.md`
5. Add only newly confirmed architectural/product decisions to `.ai/DECISIONS.md`
6. Report changed files, tests run, remaining blockers and next task

Do not claim a task is complete unless its Definition of Done is satisfied.

## Git rule
Do not push unless the user explicitly asks for a push.
Do not rewrite history or perform destructive git operations without explicit approval.

## Product invariants
- Memory is user-owned and must not be tied to one AI vendor.
- Cross-project reuse is core behavior.
- Past Memory is evidence/input, never unquestioned current truth.
- Successful directions and dead-ends are both preserved.
- Current environment/version/specification must be revalidated before reuse.
- `VERIFIED` requires actual verification evidence.
- Do not persist raw conversations, chain-of-thought, secrets, raw logs, or large code dumps as Memory.
- Switching AI must not silently fragment one ongoing Problem into unrelated Problems.
- Memory-service failure must not block normal AI work.
- Keep MVP functionality small while preserving replaceable/extensible boundaries.
- Deterministic repeated work should be implemented as normal code where practical; reserve LLM use for semantic judgment, summarization, comparison and reranking.

If an implementation shortcut violates one of these invariants, stop and surface the conflict instead of silently proceeding.
