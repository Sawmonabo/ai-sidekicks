# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**AI Sidekicks** is a desktop runtime where humans and multiple AI agents share live sessions, co-edit code through proper git flow, and collaborate in real time. The first-class primitive is the **session**, not the agent ([ADR-001](docs/decisions/001-session-is-the-primary-domain-object.md)). A session contains participants, agents, runs, channels, repo mounts, approvals, artifacts, and a unified event timeline. People and machines are both first-class participants.

Three layers:

- **Local Runtime Daemon** — machine-local execution authority. Owns provider processes (`claude-driver`, `codex-driver`), git worktrees, terminal sessions, tool execution, SQLite persistence (41 tables). Worktree-first execution mode ([ADR-006](docs/decisions/006-worktree-first-execution-mode.md)).
- **Collaboration Control Plane** — hosted or self-hosted; auth (PASETO v4 + WebAuthn + DPoP, [ADR-010](docs/decisions/010-paseto-webauthn-mls-auth.md)), invites, presence (Yjs Awareness), E2E-encrypted relay (X25519 + XChaCha20-Poly1305 in V1, MLS RFC 9420 in V2), shared metadata (Postgres, 18 tables).
- **Clients** — CLI (`sidekicks`, first delivery track) and Electron desktop shell with React/Vite renderer, both over a typed SDK + JSON-RPC IPC ([ADR-009](docs/decisions/009-json-rpc-ipc-wire-format.md)).

Stack: TypeScript across daemon/CLI/desktop/contracts; XState v5 state machines; tRPC v11 control-plane API ([ADR-014](docs/decisions/014-trpc-control-plane-api.md)); Zod validation; Cedar policy engine for approvals ([ADR-012](docs/decisions/012-cedar-approval-policy-engine.md)); OpenTelemetry; Rust PTY sidecar on Windows ([ADR-019](docs/decisions/019-windows-v1-tier-and-pty-sidecar.md)). Apache-2.0 ([ADR-020](docs/decisions/020-v1-deployment-model-and-oss-license.md)).

V1 ships 17 features ([ADR-015](docs/decisions/015-v1-feature-scope-definition.md)) across 27 implementation plans in 9 dependency tiers. The feature list and tier graph live in [`README.md`](README.md); the build-order + shared-resource ownership map lives in [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md).

## Current State: Tier 1 Code Execution Underway

Code execution started 2026-04-26 with the V1 monorepo scaffold (PR #6) — the doc-first gate cleared when [ADR-023](docs/decisions/023-v1-ci-cd-and-release-automation.md) (V1 CI/CD, pre-commit hooks, release automation) was accepted on the same date, closing [BL-100](docs/archive/backlog-archive.md). Feature branches cut off `develop` and squash-merge back per the [GitFlow-lite branch-model amendment](docs/decisions/023-v1-ci-cd-and-release-automation.md#decision-log).

Four of five [Plan-001](docs/plans/001-shared-session-core.md) phases have shipped:

| GitHub PR | Phase | Package |
| --- | --- | --- |
| #6 | Phase 1 — Workspace Bootstrap | repo bootstrap (pnpm + Turbo + Vitest + ESLint per [ADR-022](docs/decisions/022-v1-toolchain-selection.md)) |
| #8 | Phase 2 — Contracts | `packages/contracts` (session / event / error payload schemas) |
| #9 | Phase 3 — Daemon Migration + Projection | `packages/runtime-daemon` (migration, projector, append/replay) |
| #10 | Phase 4 — Control Plane Directory | `packages/control-plane` (session directory service: create/read/join) |

`package.json` is real (`pnpm@10.33.2`, Node `>=22.12.0`). Use the wired scripts: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (Turbo-driven), `pnpm format` / `pnpm format:check`. **Do not invoke `npm`** — the engines field requires pnpm. Pre-commit hooks (lefthook + lint-staged + commitlint + gitleaks) install via `pnpm prepare`. The unit of work is now mixed: `.md` files under `docs/` for governance and TypeScript under `packages/` + `apps/` for code phases. Doc-first ordering still holds — every code PR cites the plan / spec / ADR(s) it implements per [CONTRIBUTING.md](CONTRIBUTING.md).

**Active gates blocking the next code PRs:**

- **Plan-001 Phase 5** (Client SDK + Desktop Bootstrap) is the only remaining Plan-001 phase. It depends on Plan-007-partial + Plan-008-bootstrap Tier 1 carve-outs (governance merged; code TBD).
- **Plan-readiness audit** ([runbook](docs/operations/plan-implementation-readiness-audit-runbook.md), methodology PR #14, Tier 1 pilot PR #15) gates code from Tiers 2-9. The plan-template Precondition checkbox blocks `draft → review` for new plans; pre-audit `approved` plans need a retroactive audit pass before downstream code PRs land. **Tiers 2-9 audits are pending** — eight tier-PRs of audit work owed before broad Tier 2+ code execution can resume.

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
