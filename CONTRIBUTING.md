# Contributing

How work lands (branches, squash-merge, what CI and review mean on `develop`, the rules): [AGENTS.md](AGENTS.md). This file holds the mechanics.

## Commits

Conventional Commits: `type(scope): subject`. Types: `feat fix build chore ci docs perf refactor revert test`. The subject starts lowercase and the header is at most 72 characters. Scopes are package nouns (`contracts`, `crypto-paseto`, `client-sdk`, `daemon`, `control-plane`, `desktop`, `sidecar-rust-pty`, `pty-sidecar-publishing`) or `repo`, `deps`, `ci`, `format`, `release`; the hook warns on anything else and does not block. Footers: `Refs: Plan-NNN` when the change belongs to a plan; `Co-Authored-By:` for AI-authored commits.

## Branch names

Cut every branch from `develop` as `<type>/<topic>` in kebab-case, where `type` is one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`.

## Hooks

`pnpm install` installs them. Pre-commit: lint-staged (ESLint fix, Prettier) then a secret scan (gitleaks) and a markdown table-shape check; commit-msg: commitlint. Never `--no-verify`. The worktree hook needs `jq` and `python3`; the secret scan uses `gitleaks` 8.30.1 or later and only warns when it is missing; `lychee` is optional locally (CI installs its own); Claude Code's code-intelligence plugins need `typescript-language-server` and the `rust-analyzer` rustup component. When several worktrees commit at once, a repository-wide lock (`tools/lefthook-worktree-lock.mjs`) serialises them.

## Pull requests

Open the PR with the whole description in the first `gh pr create` call. The summary checks are `ci-gate` and `docs-corpus-gate`. The squash subject becomes permanent history, so keep it commitlint-valid including the ` (#NNN)` suffix. Merge with `gh pr merge <n> --squash --delete-branch`; auto-merge is off, so `--auto` errors. Retarget stacked pull requests to `develop` before deleting their base, or GitHub closes them for good. After a merge, remove the finished worktree and fast-forward local `develop`.

## Two kinds of work

- **Plan work** builds a phase of a `docs/plans/NNN-*.md` plan. Put `Plan-NNN Phase N` in the PR title so `git log --grep` finds it later. Write or amend the plan when it helps you think; land it with the code or not at all.
- **Everything else** (fixes, tooling, dependencies, docs) needs no plan relationship.

## Worktrees

`git worktree add .worktrees/<name> -b <branch> develop`. Run `pnpm install` inside a fresh worktree. Never remove a worktree another session is using (see `AGENTS.md` rule 4). Never `git stash` while more than one worktree is live; `refs/stash` is shared.
