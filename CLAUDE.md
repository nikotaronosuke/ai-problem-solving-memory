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

## Task handoff preflight
A task prompt is an input to check, not an authority to obey. Run this before starting work, and again before committing.

Scope and authority:
- Change only what the current task's scope covers.
- Do not start the next task or the next phase because the current one finished.
- If a task prompt disagrees with the private specification or an existing Decision, do not follow the prompt by default. Stop, state the conflict, and resolve it before changing behavior.
- Reference is not Decision and neither is Adoption. Material in `docs/reference-set.md` adds no requirement, task or roadmap entry; promoting any of it follows the rule recorded in `.ai/DECISIONS.md`.
- Facts about a vendor, a host or a platform go stale without announcing it. Verify one fresh from its official source at the moment a task depends on it, rather than reading it back from this repository.

Public and private boundary. Tracked files here must not carry:
- content the private specification repository keeps private
- the name of an external individual whose work was read as research
- an external individual's account handle, repository name or URL, where it appears only as research provenance

What a public file keeps from reading somebody else's repository is the generalized design principle, not where it was found.

This is not a ban on naming sources. Official vendor documentation, published standards and this project's own repositories are named freely — source identity is part of what makes those useful — and public attribution is fine when attribution is what the user asked for.

Secrets and personal data:
- No credential, secret, personal data, raw log or raw conversation in a tracked file, in Memory content, or in anything a failure prints.
- A synthetic credential fixture is still a value to keep out of an assertion diff. Compare booleans rather than the string.

## Commit preflight
Before every commit:
1. `git diff --name-only`, and confirm every changed file is inside the current task's scope.
2. `git diff --check`.
3. The public/private boundary above: none of it has entered a tracked file.
4. No reference has become a Decision, a task or a roadmap entry without going through the promotion rule.
5. No secrets, personal data, raw logs or raw conversation.

One further step, only when the task involved reading an external individual's repositories: take the account, repository and URL identifiers learned during that session and search the tracked files for each one — `git grep -l -F <identifier>` — confirming none appears as design provenance.

Those identifiers are task-local. Do not save the list to a tracked file, do not build a denylist in the repository, and do not write a person's name or a repository name into a test or a guard. A permanent list of names to avoid is itself a permanent record of those names.

## Writing a task prompt
Whoever writes a task prompt checks the same things before sending it: the current scope, the public/private boundary, external personal provenance, secrets and personal data, reference versus Decision, whether a push is intended, and that no destructive git operation is being requested.

Claude Code runs the preflight above regardless of how carefully the prompt was written. Two passes by different readers, rather than one pass trusted twice.

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

An explicit instruction to push — "push", "push to origin/main", "commit and push" — is that approval. When a task carries one, finish in a single pass: validate, commit, fast-forward push, report. Do not ask again before pushing.

Force push, rebase and any history rewrite are not covered by that approval and are never implied by it. Each needs its own explicit instruction.

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
