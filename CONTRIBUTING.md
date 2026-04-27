# Contributing

This file is the operational reference for branch naming, commit format, and PR workflow in this repository. It complements [`AGENTS.md`](AGENTS.md) (cross-tool conventions for AI coding agents) and [`CLAUDE.md`](CLAUDE.md) (Claude Code-specific instructions).

For decisions and rationale behind these choices, see [ADR-022 — V1 Toolchain Selection](docs/decisions/022-v1-toolchain-selection.md) and [ADR-023 — V1 CI/CD and Release Automation](docs/decisions/023-v1-ci-cd-and-release-automation.md).

## Repository State

The repository is in the V1 doc-first phase. There is no source code yet — `package.json` is a placeholder. The next milestone is [Plan-001](docs/plans/001-shared-session-core.md) PR #1 (the first code-execution PR). Until that PR opens, only doc PRs are expected. See [`CLAUDE.md`](CLAUDE.md) for current state details.

## Branch Model

- **Trunk-based.** `main` is the only long-lived branch.
- **Branch protection** on `main` forbids direct pushes; every change goes through a PR. Required CI checks per [ADR-023 §Axis 1](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-1--ci-workflow-architecture) must pass before merge.
- **Short-lived feature branches.** A branch should live hours-to-days, not weeks. Long-lived branches are an anti-pattern.
- **Squash-merge.** The PR title becomes the conventional-commit subject on `main`; the PR body becomes the commit body.

## Branch Naming

### Shape

Engineering-side branches use a 3-segment shape per [ADR-023 §Axis 2](docs/decisions/023-v1-ci-cd-and-release-automation.md#axis-2--pre-commit-hook-framework):

```text
<type>/<scope>/<topic>
```

This is disjoint from [Spec-011](docs/specs/011-gitflow-pr-and-diff-attribution.md)'s product-side `run/<run-id>/<topic>` namespace; both coexist without collision.

### Type segment

Based on [Conventional Branch](https://conventional-branch.github.io/) with a local `docs/` extension to mirror the Conventional Commits `docs:` type:

| Type | Use for | Example |
|---|---|---|
| `feat/` | New features | `feat/daemon/plan-001-monorepo-scaffold` |
| `fix/` | Bug fixes | `fix/desktop/plan-023-renderer-leak` |
| `hotfix/` | Urgent post-release fixes | `hotfix/relay/cve-2026-1234-token-leak` |
| `release/` | Release preparation | `release/v0.1.0` |
| `chore/` | Build / tooling / dependencies | `chore/ci/bump-pnpm` |
| `docs/` | Documentation-only | `docs/decisions/adr-024-observability` |

`docs/` is a local extension. Conventional Branch defines five types; we add `docs/` for legibility — `docs/audit-realignment` reads correctly while `chore/audit-realignment` undersells doc work.

Short-form types are pinned (`feat/`, `fix/`) — do not use the long forms (`feature/`, `bugfix/`) so the branch type matches the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) commit type 1:1.

### Scope segment

The branch scope identifies the section of the codebase being changed. Use the package directory name (when one package dominates the change) or a top-level area name.

- **Packages:** `daemon`, `desktop`, `cli`, `contracts`, `client-sdk`, `cedar-policy`, `pty-host`, `relay` (the actual scope-enum is enforced by `commitlint.config.mjs` once it lands per ADR-023 §Axis 2).
- **Areas:** `ci`, `docs`, `infra`, `scripts`.

When a change spans many packages, use the most central package as the scope, or use `repo` for monorepo-wide changes.

### Topic segment

Free-form description with required structure:

- Lowercase letters (a-z), digits (0-9), hyphens. No underscores, dots, or spaces.
- Embed the plan reference when the work is plan-scoped: `plan-NNN-<short-desc>` (e.g., `plan-001-monorepo-scaffold`).
- For non-plan work, use a description that names the change concisely.
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
- Explain *why*, not *what* — the diff already shows what.

### Footer trailers

Footer trailers are conventions, not commitlint-enforced:

- **`Refs: ADR-NNN, BL-NNN, Plan-NNN`** — cite governance documents the change implements or modifies. Use this whenever the change is traceable to a governance artifact.
- **`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`** — required when AI is a co-author of the change, per [`CLAUDE.md`](CLAUDE.md).

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

## PR Workflow

1. **Branch off `main`.** `git switch -c feat/daemon/plan-001-monorepo-scaffold`
2. **Commit using Conventional Commits format.** Pre-commit hooks (lefthook + lint-staged + commitlint) catch format errors locally; CI re-runs them as enforcement per ADR-023 §Axis 2.
3. **Open the PR.** PR title MUST match conventional-commit subject format — it becomes the squash-commit subject on `main`. PR body explains the change; code PRs include a Test Plan section.
4. **Address review.** Push additional commits to the same branch; squash-merge collapses them.
5. **Merge.** `gh pr merge --squash --delete-branch` — squashes the branch, deletes both local and remote, fast-forwards local `main`.

Branch protection ensures no direct pushes to `main`. The squash-merge produces one clean conventional-commit per PR; `release-please-action` reads these to drive per-package version bumps.

## Worked Example

A hypothetical Plan-001 PR #1 lifecycle:

```bash
# 1. Branch off main
git switch main && git pull
git switch -c feat/daemon/plan-001-monorepo-scaffold

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
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

# 4. Squash-merge after CI + review
gh pr merge --squash --delete-branch
```

The squash-commit on `main` reads:

```text
feat(daemon): scaffold monorepo with pnpm + Turbo (#2)

Scaffold the V1 monorepo per Plan-001: pnpm workspace, Turbo pipeline,
daemon package skeleton, Vitest config.

Refs: ADR-022, ADR-023, Plan-001
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Anti-Patterns

- **Direct push to `main`** — blocked by branch protection.
- **Long-lived feature branches** — branches that outlive their PR by days create merge debt.
- **Force-push to a shared branch** — never; always create a new commit and let squash-merge collapse history.
- **Skipping pre-commit hooks** (`--no-verify`) — CI re-runs the same checks per ADR-023 §Axis 2 (D-1 cross-axis), so the hook bypass costs you a CI round-trip without saving time.
- **Branches lacking the scope segment** (e.g., `feat/scaffold`) — required by the 3-segment ADR-023 shape.
- **`style:` commits** — excluded from the type-enum; use `chore(format): ...` if you genuinely need a formatting-only commit.
- **Citing `.agents/tmp/...` paths in committed docs** — those are transient drafts; per AGENTS.md, surface citations forward into the consuming doc and let `.agents/tmp/` be deleted.

## References

- [Conventional Branch](https://conventional-branch.github.io/) — branch naming spec
- [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/) — commit message spec
- [ADR-022 — V1 Toolchain Selection](docs/decisions/022-v1-toolchain-selection.md) — pnpm + Turbo + Vitest + ESLint stack
- [ADR-023 — V1 CI/CD and Release Automation](docs/decisions/023-v1-ci-cd-and-release-automation.md) — branch protection, commitlint, lefthook, release-please
- [`CLAUDE.md`](CLAUDE.md) — Claude Code instructions and AI co-authoring convention
- [`AGENTS.md`](AGENTS.md) — cross-tool conventions for AI agents
