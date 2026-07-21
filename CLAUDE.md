# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**AI Sidekicks** is a desktop runtime where humans and multiple AI agents share live sessions, co-edit code through proper git flow, and collaborate in real time. The first-class primitive is the **session**, not the agent ([ADR-001](docs/decisions/001-session-is-the-primary-domain-object.md)). A session contains participants, agents, runs, channels, repo mounts, approvals, artifacts, and a unified event timeline. People and machines are both first-class participants.

Three layers:

- **Local Runtime Daemon** — machine-local execution authority. Owns provider processes (`claude-driver`, `codex-driver`), git worktrees, terminal sessions, tool execution, SQLite persistence (52 tables). Worktree-first execution mode ([ADR-006](docs/decisions/006-worktree-first-execution-mode.md)).
- **Collaboration Control Plane** — hosted or self-hosted; auth (PASETO v4 + WebAuthn + DPoP, [ADR-010](docs/decisions/010-paseto-webauthn-mls-auth.md)), invites, presence (Yjs Awareness), E2E-encrypted relay (X25519 + XChaCha20-Poly1305 in V1, MLS RFC 9420 in V2), shared metadata (Postgres, 22 tables).
- **Clients** — CLI (`sidekicks`, first delivery track) and Electron desktop shell with React/Vite renderer, both over a typed SDK + JSON-RPC IPC ([ADR-009](docs/decisions/009-json-rpc-ipc-wire-format.md)).

Stack: TypeScript across daemon/CLI/desktop/contracts; XState v5 state machines; tRPC v11 control-plane API ([ADR-014](docs/decisions/014-trpc-control-plane-api.md)); Zod validation; Cedar policy engine for approvals ([ADR-012](docs/decisions/012-cedar-approval-policy-engine.md)); OpenTelemetry; Rust PTY sidecar on Windows ([ADR-019](docs/decisions/019-windows-v1-tier-and-pty-sidecar.md)). Apache-2.0 ([ADR-020](docs/decisions/020-v1-deployment-model-and-oss-license.md)).

V1 ships 23 features ([ADR-015](docs/decisions/015-v1-feature-scope-definition.md), amended 2026-07-02 and 2026-07-08) across 27 implementation plans in 9 dependency tiers — plus a pending 28th: feature #18 (MCP governance) is governed by Spec-028 + Plan-028, authored by the capability-enhancement campaign's B18 bundle and not yet in the corpus, so MCP-governance code is gated on Plan-028 landing and is not covered by the existing 27. Features #19–#23's governing spec amendments are in-tree via the campaign's B1/B2/B3/B6/B20 bundles and re-promoted `approved` through the W1.5 batch gate (2026-07-18), so rollback / goals / callback-tool / execution-posture / realtime implementation now waits on the campaign's W2 plan-task bundles, not the existing plans — and rollback (#19) additionally gates on the B21→B23 turn-snapshot file-restore leg (Plan-010) before Plan-004 Phase 3 dispatch per the [build-order preamble](docs/architecture/cross-plan-dependencies.md), with its superseded-turn timeline rendering riding the Spec-013/Plan-013 CP-004-13 consumer leg (`review` since 2026-07-20; restored at the Tier-8 gate). The feature list and tier graph live in [`README.md`](README.md); the build-order + shared-resource ownership map lives in [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md).

## Current State: Tier 2-4 Code Execution; Plan-Readiness Audits Through Tier 7

Code execution started 2026-04-26 with the V1 monorepo scaffold (PR #6) — the doc-first gate cleared when [ADR-023](docs/decisions/023-v1-ci-cd-and-release-automation.md) (V1 CI/CD, pre-commit hooks, release automation) was accepted on the same date, closing [BL-100](docs/archive/backlog-archive.md). Feature branches cut off `develop` and squash-merge back per the [GitFlow-lite branch-model amendment](docs/decisions/023-v1-ci-cd-and-release-automation.md#decision-log).

All five [Plan-001](docs/plans/001-shared-session-core.md) phases have shipped (Phase 5 across Lanes A–D):

| GitHub PR | Phase | Package |
| --- | --- | --- |
| #6 | Phase 1 — Workspace Bootstrap | repo bootstrap (pnpm + Turbo + Vitest + ESLint per [ADR-022](docs/decisions/022-v1-toolchain-selection.md)) |
| #8 | Phase 2 — Contracts | `packages/contracts` (session / event / error payload schemas) |
| #9 | Phase 3 — Daemon Migration + Projection | `packages/runtime-daemon` (migration, projector, append/replay) |
| #10 | Phase 4 — Control Plane Directory | `packages/control-plane` (session directory service: create/read/join) |
| #30/#36/#38 (A), #48 (B), #77 (C), #83 (D), #87 (completion) | Phase 5 — Client SDK + Desktop Bootstrap (Lanes A–D) | `packages/client-sdk` + `apps/desktop` (session bootstrap, renderer wiring, sidecar lifecycle) |

`package.json` is real (`pnpm@10.33.2`, Node `>=22.12.0`). Use the wired scripts: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (Turbo-driven), `pnpm format` / `pnpm format:check`. **Do not invoke `npm`** — the engines field requires pnpm. Pre-commit hooks (lefthook + lint-staged + commitlint + gitleaks) install via `pnpm prepare`. The unit of work is now mixed: `.md` files under `docs/` for governance and TypeScript under `packages/` + `apps/` for code phases. Doc-first ordering still holds for plan-task shipment — a lane-1 PR cites the plan / spec / ADR(s) it implements; enhancement and tooling PRs take the lighter lanes per [CONTRIBUTING.md](CONTRIBUTING.md) §How Code Lands: Work Classification.

**Active gates blocking the next code PRs:**

- **Plan-024 Phases 4-5** (CI cross-compile + signing; measurement substrate) are procurement-blocked on [BL-108](docs/backlog.md) — tracked as §6 nodes NS-09 + NS-10, the only hard-blocked code lanes on the dependency DAG.
- **Plan-readiness audit** ([runbook](docs/operations/plan-implementation-readiness-audit-runbook.md), methodology PR #14, Tier 1 pilot PR #15) gates code from Tiers 2-9 — each tier's plans must clear the audit before that tier's code PRs land. The plan-template Precondition checkbox blocks `draft → review` for new plans; pre-audit `approved` plans need a retroactive audit pass first. **Tiers 2-7 audits are complete** (NS-14 + NS-15..NS-19; the Tier-7 audit landed via PR #160), so those tiers' `approved` plans have cleared the audit gate — with one reopened exception: Plan-014's 2026-07-08 relay scope growth re-opened its Preconditions checkbox, so its Tasks 7–10 are not dispatch-eligible until the readiness-audit delta lands (Tasks 1–6 stay covered) — and audit clearance only, not code-readiness: plan-task code (lane 1 per [CONTRIBUTING.md](CONTRIBUTING.md) §How Code Lands) still dispatches in tier order and on each plan's §Preconditions — enhancement and tooling lanes are exempt (execution is underway through Tier 4). **Tiers 8-9 audits remain** — two tier-PRs owed (Tier 8 includes Plan-017's `review → approved` promotion).
- **Plan status promotion** — a code-execution plan ships its first PR only after it — and every cross-referenced spec, ADR, and plan — has completed the status promotion its [Documentation Corpus](#documentation-corpus) row requires, and every blocking backlog item is `completed` (or deferred with a named gate), per [AGENTS.md §Doc-First Discipline](AGENTS.md#doc-first-discipline). This is a separate gate, not satisfied by audit clearance or tier order alone: a plan that is audit-cleared and tier-eligible but not yet promoted stays blocked. The [README](README.md) census lists the plans not yet promoted.

## Cross-Tool Conventions

Cross-tool conventions for AI agents in this repo (Claude, Codex, Cursor, Aider) live in [`AGENTS.md`](AGENTS.md). It owns the citation standard, the transient research-artifact pattern under `.agents/tmp/research/<topic>/<axis>.md`, parallel-subagent dispatch rules, and doc-first ordering.

Branch naming, commit format, and PR workflow conventions live in [`CONTRIBUTING.md`](CONTRIBUTING.md). It owns the GitFlow-lite branch model (feature branches off `develop`; squash-merge into `develop`; `develop` → `main` only at release), [Conventional Branch](https://conventional-branch.github.io/) 2-segment shape (`<type>/<topic>`), [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/) message format with package-noun scope, footer-trailer conventions (`Refs: ADR-NNN, BL-NNN, Plan-NNN` and `Co-Authored-By:`), and squash-merge workflow per [ADR-023](docs/decisions/023-v1-ci-cd-and-release-automation.md).

Read `AGENTS.md` on demand before:

- Authoring a new spec, ADR, plan, or architecture doc that requires primary-source citations
- Dispatching parallel research subagents
- Committing any doc whose content was drafted with subagent research artifacts (the surface-forward-then-delete step)

**Anti-pattern**: never cite `.agents/tmp/...` paths from committed docs. The directory is gitignored and per-commit-deleted; surface citations forward into the consuming doc's References section before deletion (per AGENTS.md "Surface-Forward-Then-Delete").

## Worktrees

Git worktrees live under `.worktrees/<name>/` at the repo root. The harness enforces this via `WorktreeCreate` and `PreToolUse` hooks in `.claude/settings.json` — `git worktree add` or `git worktree move` to any path outside `.worktrees/` is denied. Use `git worktree add .worktrees/<name> -b worktree-<name>` when creating manually to match the harness branch-naming convention.

**Removal discipline.** Deleting a worktree that is a live process's working directory breaks every later command spawn in the occupying session (`ENOENT posix_spawn '/bin/sh'` — 2026-07-07 incident). Removals (`git worktree remove`, recursive `rm` into `.worktrees/`, harness-initiated removals via `worktree.sh`) are occupancy-checked by `command-guard.py`: an occupied removal is denied with the occupant list. Occupancy can be transient — retry once; otherwise exit the occupying session or kill the listed PIDs; the deliberate override is prefixing the exact command with `WORKTREE_REMOVE_ALLOW_OCCUPIED=1`. Bulk cleanups remove only worktrees you created, after checking `python3 .claude/hooks/command-guard.py --occupancy <path>` (empty output = unoccupied). Honest limit: a session whose _tracked_ Bash cwd is inside a worktree with no live process there at check time is invisible to the guard — the only-remove-what-you-created rule is the mitigation. Active on macOS/Linux/WSL2; inert-but-safe on native Windows (the OS itself locks in-use directories).

## Documentation Corpus

| Tree | Purpose | Template | Status Lifecycle |
| --- | --- | --- | --- |
| `docs/specs/NNN-kebab.md` | Feature specifications (the design contract) | `docs/specs/000-spec-template.md` | `draft` → `review` → `approved` (or `superseded`) |
| `docs/plans/NNN-kebab.md` | Implementation plans (executable build steps) | `docs/plans/000-plan-template.md` | `draft` → `review` → `approved` → `completed` |
| `docs/decisions/NNN-kebab.md` | ADRs (decisions with antithesis + synthesis) | `docs/decisions/000-adr-template.md` | `proposed` → `accepted` (or `deprecated` / `superseded by ADR-NNN`) |
| `docs/domain/` | Domain models, state machines, glossary | `docs/domain/template.md` | canonical when merged |
| `docs/architecture/` | Schemas, contracts, system context, deployment, security | `docs/architecture/template.md` | canonical when merged |
| `docs/operations/` | Runbooks, on-call routing, SLOs | `docs/operations/template.md` | canonical when merged |
| `docs/backlog.md` | Active work items (`BL-NNN`) | inline template in file header | `todo` / `in_progress` / `blocked` / `completed` |

Non-governance docs sit alongside the corpus and are not subject to the status lifecycle above: [`docs/vision.md`](docs/vision.md) (long-form product vision) and [`docs/reference/`](docs/reference/) (excerpted upstream materials).

ADRs are classified `Type 1` (two-way door, reversible — skip [T2] sections) or `Type 2` (one-way door, hard to reverse — complete every section).

## When Writing Documents

- **Copy the template.** New spec / plan / ADR? Start from `000-{type}-template.md`. Number sequentially within the tree (next free `NNN`).
- **Check the ownership map first.** Before adding a column, file, or directory that another plan might own, consult [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md). The owning plan `CREATE`s; dependent plans `EXTEND`.
- **Cross-link aggressively.** Every spec names its plan; every plan names its spec and Required ADRs; every backlog item names the docs that govern it.
- **Status promotion is load-bearing.** Do not flip `review` → `approved` without addressing review notes — downstream plans/specs treat the prior state as stable. ADR moves to `accepted` only after antithesis is steel-manned and synthesis is recorded.
- **Backlog discipline.** `BL-NNN` items must include References, Summary, and Exit Criteria. Move completed items to `docs/archive/backlog-archive.md` after the canonical docs are updated. Do not let `backlog.md` accumulate historical entries — rewrite or remove stale items.
