# CLAUDE.md

## Project

AI Problem-Solving Memory — a user-owned, vendor-independent store of past
problem-solving experience, reusable across assistants and across projects.

This repository is the **Problem-Solving Memory service**: a Fastify HTTP API
over PostgreSQL, plus two workspace packages that let an assistant reach it.

## Commands

```bash
npm install
npm run check        # typecheck + lint + format:check + test
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run dev          # run the server from TypeScript, with watch
```

Integration tests need a local PostgreSQL and skip themselves without
`DATABASE_URL`. `docs/development.md` covers the local stack, migrations,
owner bootstrap and credentials.

## Layout and boundaries

| Path | Contents |
| --- | --- |
| `src/domain/` | Types and rules. No storage, no transport, no vendor. |
| `src/app/` | Application services. Reaches storage only through `src/repository/`. |
| `src/repository/` | Owner-scoped repositories over `src/db/`. |
| `src/db/` | SQL and the driver. |
| `src/http/` | Fastify routes and schemas. Imports neither `pg` nor `src/db/`. |
| `src/providers/` | Concrete provider adapters, behind vendor-neutral ports. |
| `src/reliability/` | A retry queue for *callers*; the server never runs it. |
| `packages/memory-api-client/` | The JSON API client. Zero runtime dependencies, no assistant-specific knowledge. |
| `packages/claude-code-adapter/` | Everything specific to one assistant. Depends only on the client. |

The dependency direction is `domain ← app ← repository ← db ← PostgreSQL`, and
`tests/architecture.test.ts` enforces it rather than trusting it. If a change
needs to cross one of these boundaries, that is worth discussing before writing
it.

### What this repository is not

Only the Problem-Solving Memory module lives here. A tool gateway, a shared
credential hub, a general approval engine, a skill registry, a workflow engine, a
model router and an organisation-wide audit warehouse are all outside it. Do not
pull those responsibilities in as implementation shortcuts.

## Product invariants

- Memory is the user's and must not be tied to one AI vendor.
- Cross-project reuse is the core behaviour, not an extra.
- Past Memory is evidence, never unquestioned current truth. Current
  environment, versions and specifications are revalidated before reuse.
- Successful directions and dead ends are both preserved.
- `VERIFIED` requires actual verification evidence.
- Raw conversations, chain-of-thought, secrets, raw logs and large code dumps are
  not stored as Memory.
- Memory-service failure must not block the work it was helping.
- Deterministic repeated work belongs in ordinary code; reserve model inference
  for semantic judgement, summarisation, comparison and reranking.

If a shortcut would violate one of these, raise the conflict rather than
proceeding quietly.

## Conventions

- ESM only. Relative imports carry the `.js` extension (`NodeNext` resolution).
- TypeScript strict. Prefer fixing a type over `any` or an assertion.
- Comments explain *why*. What the code does is already in the code.
- Tests are part of the change, not a follow-up.

## Contributing safely

- **Never commit a credential, secret, personal data, raw log or raw
  conversation** — not in code, not in a fixture, not in a test's output. Test
  fixtures that look like credentials are synthetic, and assertions about them
  compare booleans so a failure diff cannot print the value.
- `.env` is ignored and stays that way. `.env.example` shows the shape.
- Avoid destructive git operations. Force pushes, rebases of shared history and
  history rewrites need to be agreed first.
- `CLAUDE.local.md` is git-ignored, for your own machine-specific notes and
  instructions. It is loaded alongside this file and is never committed.
