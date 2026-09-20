# Design decisions

English | [日本語](design-decisions.md)

This document was organized retrospectively on 2026-09-20 from the existing commit history. The date of each decision is based on the linked evidence commit.

## 2026-08-12 — Separate FIX from Verification

An AI saying "I fixed it" is not the same as a check actually passing.

A FIX Event therefore cannot move a Problem to VERIFIED by itself. Verification is an independent entity, and failed Verification remains evidence too.

**Evidence:** [independent verification evidence](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/c21020b0d49ddd6586a3242fdd6461c3e8807cda)

## 2026-08-14 — Use enqueue-before-send instead of send-first

A durable client-side queue was added so Memory failure would not stop the caller's main work.

The design was then tightened for timeout-after-commit cases: send-first leaves a loss window if the process exits after a failed attempt but before the failed write is persisted locally.

The final order became **sanitize → durable queue → send**, with the same `client_event_id` reused across retries.

**Evidence:** [durable client-side queue](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/98312cfa839c48b4c24310e11c6baab44db4e0e3) / [enqueue before send](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/73550ac0a5dd6f1c8cdea5786de5ae91ce4241c7)

## 2026-08-19 — Resolve the current project from each call, not startup state

Real-host testing showed that a project location captured at session startup could remain pointed at the original repository after the session moved to another repository.

Current project resolution therefore moved to per-call host context. If usable location is unavailable, the call is refused instead of falling back to stale project state.

**Evidence:** [resolve project from current call context](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4817b8cd0eef5bc591e6c1fdcbff569563bd8415)

## 2026-08-24 — Keep one Memory across Claude Code and Codex

A real installed Codex host successfully continued a Problem started in Claude Code using the **same `problem_id`**.

The system therefore keeps one MCP core and one Problem state instead of creating separate Memory silos per host.

**Evidence:** [Codex continues the same Problem](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4c00d57a4082cb5abf8d74a35ae8d31f8cb22ca0)
