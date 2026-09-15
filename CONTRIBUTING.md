# Contributing

Mechanics only. What the project is, how work lands, and the rules are in [`AGENTS.md`](AGENTS.md).

## Commits

Conventional Commits: `type(scope): subject`. Types: `feat fix build chore ci docs perf refactor revert test`. The subject starts lowercase and the header is at most 72 characters. Scopes are package nouns (`contracts`, `crypto-paseto`, `client-sdk`, `daemon`, `control-plane`, `desktop`, `sidecar-rust-pty`, `pty-sidecar-publishing`) or `repo`, `deps`, `ci`, `format`, `release`; the hook warns on anything else and does not block. Footers: `Refs: Plan-NNN` when the change belongs to a plan; `Co-Authored-By:` for AI-authored commits.

## Branch names

`<type>/<topic>` in kebab-case, where `type` is one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`.

## Hooks

`pnpm install` installs them. Pre-commit: lint-staged (ESLint fix, Prettier) then a secret scan (gitleaks) and a markdown table-shape check; commit-msg: commitlint. Never `--no-verify`. When several worktrees commit at once, a repository-wide lock (`tools/lefthook-worktree-lock.mjs`) serialises them.

## Pull requests

Open the PR with the whole description in the first `gh pr create` call. CI runs (`ci-gate`, `docs-corpus-gate`) and the Codex bot reviews. Squash-merge when you decide; the squash subject becomes permanent history, so keep it commitlint-valid including the ` (#NNN)` suffix. Delete the branch afterwards.

## Two kinds of work

- **Plan work** builds a phase of a `docs/plans/NNN-*.md` plan. Put `Plan-NNN Phase N` in the PR title so `git log --grep` finds it later. Write or amend the plan when it helps you think; land it with the code or not at all.
- **Everything else** (fixes, tooling, dependencies, docs) needs no plan relationship.

## Worktrees

`git worktree add .worktrees/<name> -b <branch> develop`. Run `pnpm install` inside a fresh worktree. Never remove a worktree another session is using (see `AGENTS.md` rule 4). Never `git stash` while more than one worktree is live; `refs/stash` is shared.
