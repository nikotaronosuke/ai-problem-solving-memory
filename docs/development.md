# Development

Local setup and the fixed commands for this repository.

## Requirements

- Node.js >= 22.12.0 (Node 24 is also supported)
- npm (the package manager for this repository; `package-lock.json` is committed)

## Setup

```bash
npm install
cp .env.example .env
```

`.env` is git-ignored. `.env.example` contains placeholders only and must never
hold real values.

## Commands

| Command                | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | Run the entrypoint from TypeScript, with watch  |
| `npm run build`        | Compile `src/` to `dist/`                       |
| `npm start`            | Run the compiled entrypoint                     |
| `npm run typecheck`    | Type-check `src/` and `tests/` without emitting |
| `npm run lint`         | ESLint (type-aware rules enabled)               |
| `npm run lint:fix`     | ESLint with autofix                             |
| `npm run format`       | Prettier, writing changes                       |
| `npm run format:check` | Prettier, verifying only                        |
| `npm test`             | Vitest, single run                              |
| `npm run test:watch`   | Vitest, watch mode                              |
| `npm run check`        | typecheck + lint + format:check + test          |

Run `npm run check` before reporting a task complete.

## Layout

| Path     | Contents                                               |
| -------- | ------------------------------------------------------ |
| `src/`   | Service implementation                                 |
| `tests/` | Automated tests, mirroring `src/`                      |
| `db/`    | Schema and migrations (from P1-03)                     |
| `docs/`  | Public implementation documentation                    |
| `.ai/`   | Implementation state for AI sessions — see `CLAUDE.md` |

## Conventions

- ESM only (`"type": "module"`). Relative imports carry the `.js` extension,
  as required by TypeScript's `NodeNext` resolution.
- TypeScript runs in strict mode. Prefer fixing types over `any` or assertions.
- Deterministic, repeatable work belongs in ordinary code. Reserve model
  inference for semantic judgement — summarisation, similarity, comparison.

## Scope reminder

This repository is the Problem-Solving Memory service alone. It is not the
Personal AI Development OS. Tool Gateway, shared credential management, the
shared Approval Engine, Skill Registry, Workflow Engine, Model Router and the
OS-wide audit warehouse stay outside this repository. See `CLAUDE.md`.
