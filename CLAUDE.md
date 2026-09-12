# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**AI Sidekicks** is an agentic coding desktop runtime: one user and their AI sidekicks (Claude Code, Codex) building software in live sessions. The first-class primitive is the **session**, not the agent ([ADR-001](docs/decisions/001-session-is-the-primary-domain-object.md)). A session contains the user, agents, runs, channels, repo mounts, approvals, artifacts, and an event log. One user, many linked devices, one machine executing — a session is driven from any linked device and runs where the repo is.

Three layers:

- **Local Runtime Daemon** — machine-local execution authority. Owns provider processes (`claude-driver`, `codex-driver`), git worktrees, terminal sessions, tool execution, SQLite persistence (59 tables). Worktree-first execution mode ([ADR-006](docs/decisions/006-worktree-first-execution-mode.md)).
- **Control Plane** — hosted or self-hosted; auth (PASETO v4 + WebAuthn + DPoP, [ADR-010](docs/decisions/010-paseto-webauthn-mls-auth.md)), the device directory, and the encrypted relay between your devices and your machine (X25519 + XChaCha20-Poly1305 in V1, MLS RFC 9420 in V2), shared metadata (Postgres, 26 tables).
- **Clients** — CLI (`sidekicks`, first delivery track) and Electron desktop shell with React/Vite renderer, both over a typed SDK + JSON-RPC IPC ([ADR-009](docs/decisions/009-json-rpc-ipc-wire-format.md)).

Stack: TypeScript across daemon/CLI/desktop/contracts; XState v5 state machines; tRPC v11 control-plane API ([ADR-014](docs/decisions/014-trpc-control-plane-api.md)); Zod validation; Cedar policy engine for approvals ([ADR-012](docs/decisions/012-cedar-approval-policy-engine.md)); OpenTelemetry; Rust PTY sidecar on Windows ([ADR-019](docs/decisions/019-windows-v1-tier-and-pty-sidecar.md)). Apache-2.0 ([ADR-020](docs/decisions/020-v1-deployment-model-and-oss-license.md)).

The feature list and tier graph live in [`README.md`](README.md); the forward build order for the phases still to ship lives in `docs/architecture/cross-plan-dependencies.md`.

## Current State

Code execution is under way. What has merged, read off each plan's `### Shipment Manifest`:

| Plan | Phases merged |
| --- | --- |
| [Plan-001](docs/plans/001-shared-session-core.md) Shared session core | 1-5 (all) |
| [Plan-003](docs/plans/003-runtime-node-attach.md) Runtime-node attach | 1-5 (all) |
| [Plan-004](docs/plans/004-queue-steer-pause-resume.md) Queue, steer, pause, resume | 1 |
| [Plan-005](docs/plans/005-provider-driver-contract-and-capabilities.md) Provider driver contract | 1-4 |
| [Plan-006](docs/plans/006-session-event-taxonomy-and-audit-log.md) Event taxonomy and audit log | 1-3 |
| [Plan-007](docs/plans/007-local-ipc-and-daemon-control.md) Local IPC and daemon control | 1-3 |
| [Plan-009](docs/plans/009-repo-attachment-and-workspace-binding.md) Repo attachment and workspace binding | 1-2 |
| [Plan-010](docs/plans/010-worktree-lifecycle-and-execution-modes.md) Worktree lifecycle | 1, 2, 5, 6 |
| [Plan-013](docs/plans/013-live-timeline-visibility-and-reasoning-surfaces.md) Live timeline visibility | 1 |
| [Plan-023](docs/plans/023-desktop-shell-and-renderer.md) Desktop shell and renderer | 1 (with its 1B and 1C supplements) |
| [Plan-024](docs/plans/024-rust-pty-sidecar.md) Rust PTY sidecar | 1-3 |
| [Plan-029](docs/plans/029-provider-accounts-and-credential-homes.md) Provider accounts | 1 |

**What to build next** is the forward DAG in [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md): the phases not yet implemented, the real dependencies between them, and which groups can run in parallel. A phase is deleted from that graph by the PR that merges it.

Two gates still bind a lane-1 plan-task PR, and only a lane-1 PR — enhancement and tooling lanes are exempt per [CONTRIBUTING.md](CONTRIBUTING.md) §How Code Lands: Work Classification:

- **Tier order.** A plan's code ships in the tier order the [README](README.md) graph gives, and on the plan's own `### Preconditions`.
- **Plan status promotion.** A plan ships its first PR only once it — and every spec, ADR, and plan it cross-references — carries the status its [Documentation Corpus](#documentation-corpus) row requires, and every blocking backlog item is `completed` or deferred behind a named gate. Audit clearance and tier eligibility do not substitute for it.

One lane is hard-blocked: [Plan-024](docs/plans/024-rust-pty-sidecar.md) Phases 4-5 (CI cross-compile and signing; the measurement substrate) wait on hardware and certificate procurement ([BL-108](docs/backlog.md)).

Build and hook mechanics: `pnpm@10.33.2`, Node `>=22.14.0`. Use the wired scripts — `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (Turbo-driven), `pnpm format` / `pnpm format:check`. **Do not invoke `npm`** — the engines field requires pnpm. Pre-commit hooks (lefthook + lint-staged + commitlint + gitleaks) install via `pnpm prepare`. Feature branches cut off `develop` and squash-merge back per the [GitFlow-lite branch-model amendment](docs/decisions/023-v1-ci-cd-and-release-automation.md#decision-log). Doc-first ordering holds for plan-task shipment: a lane-1 PR cites the plan / spec / ADR(s) it implements.

## Cross-Tool Conventions

Cross-tool conventions for AI agents in this repo (Claude, Codex, Cursor, Aider) live in [`AGENTS.md`](AGENTS.md). It owns the citation standard, the transient research-artifact pattern under `.agents/tmp/research/<topic>/<axis>.md`, parallel-subagent dispatch rules, and doc-first ordering.

Branch naming, commit format, and PR workflow conventions live in [`CONTRIBUTING.md`](CONTRIBUTING.md). It owns the GitFlow-lite branch model (feature branches off `develop`; squash-merge into `develop`; `develop` → `main` only at release), [Conventional Branch](https://conventional-branch.github.io/) 2-segment shape (`<type>/<topic>`), [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/) message format with package-noun scope, footer-trailer conventions (`Refs: ADR-NNN, BL-NNN, Plan-NNN` and `Co-Authored-By:`), and squash-merge workflow per [ADR-023](docs/decisions/023-v1-ci-cd-and-release-automation.md).

Read `AGENTS.md` on demand before:

- Authoring a new spec, ADR, plan, or architecture doc that requires primary-source citations
- Dispatching parallel research subagents
- Committing any doc whose content was drafted with subagent research artifacts (the surface-forward-then-delete step)

**Anti-pattern**: never cite `.agents/tmp/...` paths from committed docs. The directory is gitignored and manually pruned — no hook deletes it; surface citations forward into the consuming doc's References section, then delete the research file yourself before the consuming-doc commit lands (per AGENTS.md "Surface-Forward-Then-Delete").

## Product Code Carries No Governance Identifiers

Nothing under `packages/` or `apps/` may name a `Spec-NNN`, `Plan-NNN`, `ADR-NNN`, `BL-NNN`, or `NS-NN` document, nor an `I-` / `CP-` / `D-` / `AC-` / `T-` invariant or task id, nor a `§Heading` cite or a `file.md:NNN` line pin — not in comments, not in runtime strings, not in test titles or `describe` labels, not in fixture fields, not in identifiers. Comments say what the code does and why, in plain words a reader with no access to the governance corpus can follow; a comment that would say nothing once its citation is removed is deleted rather than left dangling. Product code also carries no pull-request numbers, no review-round or merge-history narrative, and no plan-tier vocabulary; a comment states the engineering reason and never its provenance. The same files carry none of this product's banned vocabulary either: reference-app branding, `AO`, `Take Control`, `work band`, `design mode`, `mascot`, `front burner`, `back burner`, `discussion mode`, `local-first`, `one timeline`, `unified timeline`, `shared timeline`. This is a rule reviewers and authors apply by reading — there is no ESLint rule and no source-reading gate behind it, and none is to be added.

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
- **Check the owning plan first.** Before adding a column, file, or directory that another plan might own, read that plan's own Target Areas and phase tables under `docs/plans/`. The owning plan `CREATE`s; dependent plans `EXTEND`.
- **Cross-link aggressively.** Every spec names its plan; every plan names its spec and Required ADRs; every backlog item names the docs that govern it.
- **Status promotion is load-bearing.** Do not flip `review` → `approved` without addressing review notes — downstream plans/specs treat the prior state as stable. ADR moves to `accepted` only after antithesis is steel-manned and synthesis is recorded.
- **Backlog discipline.** `BL-NNN` items must include References, Summary, and Exit Criteria. Move completed items to `docs/archive/backlog-archive.md` after the canonical docs are updated. Do not let `backlog.md` accumulate historical entries — rewrite or remove stale items.
