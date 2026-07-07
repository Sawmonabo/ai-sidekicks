# Contributing

This file is the operational reference for branch naming, commit format, and PR workflow in this repository. It complements [`AGENTS.md`](AGENTS.md) (cross-tool conventions for AI coding agents) and [`CLAUDE.md`](CLAUDE.md) (Claude Code-specific instructions).

For decisions and rationale behind these choices, see [ADR-022 — V1 Toolchain Selection](docs/decisions/022-v1-toolchain-selection.md) and [ADR-023 — V1 CI/CD and Release Automation](docs/decisions/023-v1-ci-cd-and-release-automation.md).

## Repository State

The repository is in mixed doc + code execution: [Plan-001](docs/plans/001-shared-session-core.md) has shipped all five phases, `package.json` is real (pnpm workspace + Turbo), and code PRs land tier by tier alongside governance docs. [`CLAUDE.md`](CLAUDE.md) §Current State is the live census of shipped PRs, active gates, and audit status — this file deliberately does not duplicate it.

## Branch Model

- **GitFlow-lite.** Two long-lived branches: `develop` (integration — feature PRs land here) and `main` (release — only release-tagged commits land here). Per [ADR-023 §Decision Log 2026-04-26 amendment](docs/decisions/023-v1-ci-cd-and-release-automation.md#decision-log).
- **Branch protection** on both `develop` and `main` forbids direct pushes; every change goes through a PR. Required CI checks per [ADR-023 §Axis 1](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-1--ci-workflow-architecture) must pass before merge.
- **Short-lived feature branches off `develop`.** A branch should live hours-to-days, not weeks. Long-lived feature branches are an anti-pattern.
- **Squash-merge into `develop`.** The PR title becomes the conventional-commit subject on `develop`; the PR body becomes the commit body.
- **`develop` → `main` only at release.** `release-please-action` observes `develop` and orchestrates a `develop` → `main` integration that ultimately tags the release on `main`. See [ADR-023 §Axis 3](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-3--release-automation).

## Branch Naming

### Shape

Engineering-side branches follow the 2-segment [Conventional Branch](https://conventional-branch.github.io/) spec per [ADR-023 §Axis 2 (amended 2026-04-26)](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-2--pre-commit-hook-framework):

```text
<type>/<topic>
```

This namespace is disjoint from [Spec-011](docs/specs/011-gitflow-pr-and-diff-attribution.md)'s product-side `run/<run-id>/<topic>` via the type-prefix (`feat/...` vs `run/...`), so both shapes coexist without collision.

Package scope lives in the commit subject (`feat(daemon): ...`), not the branch path. A branch identifies what kind of change is in flight; the commit identifies which package the diff lands in. Duplicating the package noun in both places adds noise without adding information.

### Type segment

Based on [Conventional Branch](https://conventional-branch.github.io/) with a local `docs/` extension to mirror the Conventional Commits `docs:` type:

| Type       | Use for                        | Example                                 |
| ---------- | ------------------------------ | --------------------------------------- |
| `feat/`    | New features                   | `feat/plan-001-monorepo-scaffold`       |
| `fix/`     | Bug fixes                      | `fix/plan-023-renderer-leak`            |
| `hotfix/`  | Urgent post-release fixes      | `hotfix/cve-2026-1234-relay-token-leak` |
| `release/` | Release preparation            | `release/v0.1.0`                        |
| `chore/`   | Build / tooling / dependencies | `chore/bump-pnpm`                       |
| `docs/`    | Documentation-only             | `docs/add-observability-adr`            |

`docs/` is a local extension. Conventional Branch defines five types; we add `docs/` for legibility — `docs/audit-realignment` reads correctly while `chore/audit-realignment` undersells doc work.

Short-form types are pinned (`feat/`, `fix/`) — do not use the long forms (`feature/`, `bugfix/`) so the branch type matches the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) commit type 1:1.

### Topic segment

Free-form description with required structure:

- Lowercase letters (a-z), digits (0-9), hyphens. No underscores, dots, or spaces.
- Embed the plan reference when the work is plan-scoped: `plan-NNN-<short-desc>` (e.g., `plan-001-monorepo-scaffold`).
- For non-plan work, use a description that names the **change**, not the **file** — `add-git-workflow-conventions` ✓, `contributing-md` ✗ (filename + extension is a code smell; describe what was added or modified).
- Use action verbs for descriptive topics: `add-`, `fix-`, `rewrite-`, `migrate-`, `remove-`. The verb makes the branch name read like a sentence ("docs / add git workflow conventions").
- No leading or trailing hyphens. No consecutive hyphens.
- Dots are permitted only in `release/` topic segments (e.g., `release/v0.1.0`).

## Commit Format

Use [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/) enforced by commitlint per [ADR-023 §Axis 2](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-2--pre-commit-hook-framework).

### Subject line

```text
<type>(<scope>): <description>
```

- **Type:** one of `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `test` (10 types — `style` is excluded; Prettier auto-applies formatting via `lint-staged`, so a "pure formatting" commit shouldn't exist; use `chore(format): ...` if a manual formatting pass is genuinely needed).
- **Scope:** required; same scope-enum as branch scope above.
- **Description:** imperative ("add", not "added" or "adds"), lowercase, no trailing period, under 72 characters total header length (commitlint default).

### Body

- Optional. Include when the change benefits from explanation.
- Wrap at 72 characters.
- Explain _why_, not _what_ — the diff already shows what.

### Footer trailers

Footer trailers are conventions, not commitlint-enforced:

- **`Refs: ADR-NNN, BL-NNN, Plan-NNN`** — cite governance documents the change implements or modifies. Use this whenever the change is traceable to a governance artifact.
- **`Co-Authored-By: <running model identity> <noreply@anthropic.com>`** — required when AI is a co-author of the change. Derive the name from the running model's harness-provided identity (for Claude Code, the trailer the harness specifies at session start — `Claude Fable 5` as of 2026-06; see [`AGENTS.md`](AGENTS.md) §Model Policy). Never copy a model name from an older commit or example.

### Breaking changes

Two equivalent forms:

```text
feat(contracts)!: rename Session.id to Session.uuid
```

OR

```text
feat(contracts): rename Session.id to Session.uuid

BREAKING CHANGE: clients must update Session.id references.
```

Either form drives a major-version bump in [`release-please-action`](https://github.com/googleapis/release-please-action) per [ADR-023 §Axis 3](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-3--release-automation).

## Pre-Commit Hooks

`pnpm install` provisions the [lefthook](https://github.com/evilmartians/lefthook) chain (`lefthook install` runs via `prepare` script). The chain runs in parallel: `lint-staged` + `gitleaks` + `docs-anchor-check` + `docs-corpus-checks`, then `commitlint` on the message. CI re-runs the same checks as the authoritative gate per [ADR-023 §Axis 2](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-2--pre-commit-hook-framework).

**Gitleaks (canonical version v8.30.1)** per [ADR-023 §Axis 4 sub-axis 4](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-4--supply-chain-hygiene). Install locally:

```bash
# macOS (Homebrew currently ships ≥ v8.30):
brew install gitleaks

# Linux / other — download the v8.30.1 release tarball directly:
# https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1

# Verify:
gitleaks version   # → 8.30.1
```

If the binary is missing, the lefthook hook emits a `WARNING:` to stderr and lets the commit through — CI is the authoritative gate. Skipping the local hook (`git commit --no-verify`) is rejected at CI time anyway.

## PR Workflow

1. **Branch off `develop`.** `git switch develop && git pull && git switch -c feat/plan-001-monorepo-scaffold`
2. **Commit using Conventional Commits format.** Pre-commit hooks (lefthook + lint-staged + commitlint) catch format errors locally; CI re-runs them as enforcement per ADR-023 §Axis 2.
3. **Open the PR (base `develop`).** PR title MUST match conventional-commit subject format — it becomes the squash-commit subject on `develop`. A **lane-1 PR** (ships or modifies tasks tracked in a plan's Shipment Manifest / task DAG — see §How Code Lands below) MUST also include the `Plan-NNN` token in the title: the plan-execution preflight's manifest-freshness gate recovers shipment drift by searching merged PR titles (`Plan-NNN in:title`), and a title carrying the plan only in the body `Refs:` line is invisible to it. Lane-2/3 PRs MUST NOT carry the token — their invisibility to that gate is the lane boundary working as designed, not a gap. PR body explains the change; code PRs include a Test Plan section.
4. **Address review.** Push additional commits to the same branch; squash-merge collapses them.
5. **Merge.** `gh pr merge --squash --delete-branch` — squashes the branch, deletes both local and remote, fast-forwards local `develop`.

Branch protection ensures no direct pushes to `develop` or `main`. The squash-merge produces one clean conventional-commit per PR on `develop`; `release-please-action` observes `develop` to drive per-package version bumps and orchestrates `develop` → `main` integration at release time.

## How Code Lands: Work Classification

Classify the change before branching; the lane decides the ceremony. When in doubt between lanes 2 and 4, the boundary rule below decides.

| # | Lane | What qualifies | Ceremony |
| --- | --- | --- | --- |
| 1 | **Plan-task shipment** | Implementing, fixing, or extending tasks tracked in a plan's Shipment Manifest / task DAG — a phase in flight, a partial re-ship, a plan-scoped extension | `Plan-NNN` in the PR title; manifest entry; doc-first + audit gates per [AGENTS.md §Doc-First Discipline](AGENTS.md#doc-first-discipline); dispatches in tier order and on plan §Preconditions; `/plan-execution` optional |
| 2 | **Post-completion enhancement** | Changing code a completed/shipped plan phase introduced, staying within the approved spec envelope | Ordinary Conventional-Commit PR + `Refs: Plan-NNN` footer for traceability; **no** title token, **no** manifest entry, **no** preflight; ordinary review + CI |
| 3 | **Repo tooling / infra / chore** | `.claude/**`, `tools/**`, CI workflows, hooks, scripts, dependency bumps — work no plan owns | Plain conventional PR; no plan relationship at all |
| 4 | **Behavior-contract change** | Anything that alters a plan §Invariant (I-NNN-M) or a spec Required Behavior / Acceptance Criteria row — including on already-shipped code | Spec/plan amendment FIRST (doc-first), then lane 1 |

**Boundary rule (lane 2 vs lane 4).** If the diff changes what a plan §Invariants entry or a spec Required Behavior / Acceptance Criteria row asserts, it is NOT an enhancement — the governing doc amends first. If behavior stays within the approved spec envelope, it is lane 2 regardless of which plan originally shipped the file.

**Tier order binds lane 1 only.** The §5 tier sequence and §6 dispatch state in [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md) gate plan-task dispatch; lanes 2–3 are exempt.

**Why the lanes preserve doc-first's purpose.** The discipline exists to prevent hallucinated or untracked work, not to defer capability — "anything that is done is documented so it's not gone unknown and tracked properly" (the recorded owner ratification R9 in `docs/superpowers/specs/2026-07-01-capability-enhancements-design.md` §1.3). Lane 1 tracks through the plan's Shipment Manifest; lane 2 tracks through the `Refs:` footer and git history; lane 4 routes contract changes back through the doc. Every lane keeps the work known and attributable — the lanes change the WEIGHT of tracking, never its existence.

**History recovery for lane 2.** Enhancement PRs are deliberately invisible to the preflight manifest-freshness gate (it searches `Plan-NNN in:title`). Recover enhancement history with `git log --grep 'Refs:.*Plan-NNN'`. Note the `Refs:` footer is convention-enforced (review), not commitlint-enforced — reviewers check it on lane-2 PRs.

## Worked Example

A hypothetical Plan-001 PR #1 lifecycle:

```bash
# 1. Branch off develop
git switch develop && git pull
git switch -c feat/plan-001-monorepo-scaffold

# 2. Make commits
git commit -m "feat(daemon): scaffold pnpm workspace + Turbo pipeline"
git commit -m "feat(daemon): add Vitest config for daemon package"
git commit -m "test(daemon): add scaffold smoke test"

# 3. Open PR
gh pr create --title "feat(daemon): scaffold monorepo with pnpm + Turbo" \
  --body "$(cat <<'EOF'
## Summary

Scaffold the V1 monorepo per [Plan-001](docs/plans/001-shared-session-core.md):
pnpm workspace, Turbo pipeline, daemon package skeleton, Vitest config.

## Test plan

- [ ] `pnpm install` succeeds on Node 22.12+ and 24.x
- [ ] `turbo run build` succeeds across the workspace
- [ ] `vitest run` exits 0 with the scaffold smoke test

Refs: ADR-022, ADR-023, Plan-001
Co-Authored-By: <model identity — §Footer trailers> <noreply@anthropic.com>
EOF
)"

# 4. Squash-merge after CI + review
gh pr merge --squash --delete-branch
```

The squash-commit on `develop` reads:

```text
feat(daemon): scaffold monorepo with pnpm + Turbo (#2)

Scaffold the V1 monorepo per Plan-001: pnpm workspace, Turbo pipeline,
daemon package skeleton, Vitest config.

Refs: ADR-022, ADR-023, Plan-001
Co-Authored-By: <model identity — §Footer trailers> <noreply@anthropic.com>
```

## Anti-Patterns

- **Direct push to `develop` or `main`** — blocked by branch protection on both.
- **Long-lived feature branches** — branches that outlive their PR by days create merge debt.
- **Force-push to a shared branch** — never; always create a new commit and let squash-merge collapse history.
- **Skipping pre-commit hooks** (`--no-verify`) — CI re-runs the same checks per ADR-023 §Axis 2 (D-1 cross-axis), so the hook bypass costs you a CI round-trip without saving time.
- **Branch topics that name the file instead of the change** (`docs/contributing-md` ✗, `docs/add-git-workflow-conventions` ✓) — the topic should describe what the diff _does_, not which file it touches. Filename + extension in the topic is a code smell.
- **`style:` commits** — excluded from the type-enum; use `chore(format): ...` if you genuinely need a formatting-only commit.
- **Citing `.agents/tmp/...` paths in committed docs** — those are transient drafts; per AGENTS.md, surface citations forward into the consuming doc and let `.agents/tmp/` be deleted.
- **Adding a package without `tsconfig.test.json`** — every workspace package ships a sibling `tsconfig.test.json` so test files (`src/**/__tests__/**`, excluded from production `tsconfig.json`) can be type-validated via `tsc -p tsconfig.test.json` without emitting. The package's `typecheck` script MUST be `tsc -b && tsc -p tsconfig.test.json` (uniform invariant across every workspace package — see existing packages for reference). Model new `tsconfig.test.json` files on `packages/contracts/tsconfig.test.json` — same `composite: false` + `noEmit: true` + `declaration: true` shape; pick `tsconfig.node22.json` or `tsconfig.node24.json` as the `extends` base to match the package's runtime tier.

## References

- [Conventional Branch](https://conventional-branch.github.io/) — branch naming spec
- [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/) — commit message spec
- [ADR-022 — V1 Toolchain Selection](docs/decisions/022-v1-toolchain-selection.md) — pnpm + Turbo + Vitest + ESLint stack
- [ADR-023 — V1 CI/CD and Release Automation](docs/decisions/023-v1-ci-cd-and-release-automation.md) — branch protection, commitlint, lefthook, release-please
- [`CLAUDE.md`](CLAUDE.md) — Claude Code instructions and AI co-authoring convention
- [`AGENTS.md`](AGENTS.md) — cross-tool conventions for AI agents
