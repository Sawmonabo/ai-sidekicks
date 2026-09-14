# CLAUDE.md

## What this is

AI Sidekicks is an agentic coding desktop runtime: one user and their AI sidekicks (Claude Code, Codex) building software in live sessions. The session is the primary object ([ADR-001](docs/decisions/001-session-is-the-primary-domain-object.md)). Three layers: a local runtime daemon (provider processes, git worktrees, terminals, SQLite), a control plane (auth, device directory, encrypted relay, Postgres), and clients (the `sidekicks` CLI first, then the Electron desktop). TypeScript throughout; XState v5; tRPC v11; Zod; Cedar for approval policy; a Rust PTY sidecar on Windows. Apache-2.0.

Features: [README.md](README.md). What is left to build and in what order: [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md). What has shipped: `git log --oneline --grep 'Plan-NNN'`.

## Commands

pnpm 10.33.2, Node ≥ 22.14. Never `npm` (the engines field rejects it).

- `pnpm install` (also installs the git hooks)
- `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build` · `pnpm format`
- Desktop, cheap and headless: `pnpm --filter @ai-sidekicks/desktop run test:console-unit`; the Electron tiers run in CI.

## How work lands

Branch off `develop` as `<type>/<topic>`, open a PR, squash-merge. CI and Codex review run on every PR and report; on `develop` they inform, they never block. `main` is the release branch and the only protected one. Commit messages: `type(scope): subject`, lowercase, header ≤ 72 characters; the hook checks the format and warns on an unknown scope.

## Rules with a reason

1. **No secrets in the tree.** The pre-commit scan and the CI scan both run; a leaked key cannot be un-pushed.
2. **Never `git commit --no-verify`.** The hook is the secret scan.
3. **Product code (`packages/`, `apps/`) carries no governance identifiers** — no `Spec-NNN`, `Plan-NNN`, `ADR-NNN`, `BL-NNN`, invariant or task ids, links into `docs/`, PR numbers, review history — and no reference-app branding. A comment says what the code does and why in plain words, or it is deleted. Applied by reading; there is no lint rule and none is to be added.
4. **Git worktrees live under `.worktrees/<name>/`.** Removing a worktree another session is using breaks that session (2026-07-07 incident); the removal hook refuses while it is occupied. `python3 .claude/hooks/command-guard.py --occupancy <path>` prints the occupants; empty means free. `WORKTREE_REMOVE_ALLOW_OCCUPIED=1` overrides.
5. **No home-made structure checkers.** No source-parsing test suites, census tests, or prose-claim gates; a structural rule is a line in a standard tool's config (ESLint, knip, dependency-cruiser) or a sentence in this file. 41,000 lines of such tests were deleted on 2026-09-09.

## Engineering rules

This is a greenfield product with no released version and no external users. That sets the bar for how code changes:

1. **Fix in place. No backwards compatibility, no migrations, no deprecation shims.** When a type, schema, table, or API changes, change it and every caller in the same PR. A `v2` beside a `v1`, a compat adapter, or a data migration is a defect.
2. **Search before you write.** Before adding a helper, type, hook, or component, find the existing one: `rg` across `packages/` and `apps/`, and the language server's references and definitions. Reuse or extend it. Two functions that do the same thing is a defect.
3. **Prefer a maintained library over new code.** If a well-maintained dependency already solves the problem, use it. Home-grown parsers, schedulers, validators, and utilities are code the project must maintain forever.
4. **Leave no slop.** No dead code, no unused exports, no commented-out blocks, no placeholder branches, no comments that restate the code, no defensive checks for cases that cannot happen. Find dead code with the tools, not by eye: `knip` for unused exports and files, `tsc` for unused locals, the call graph for unreachable functions, and confirm each hit against rule 13 before removing it. A change is done when the diff contains only what the feature needs.
5. **Tests only where failure is expensive.** Test the critical path, the edge that corrupts data or leaks a secret, the boundary another package depends on. No tests for shape, coverage, or wiring; no redundant tests; no test that would still pass with the feature deleted.
6. **Files stay under about 900 lines.** A file that grows past that is split by responsibility in the same PR.
7. **Generic, reusable interfaces.** Components, views, pages, services, and stores expose a small typed interface and are built to be composed; one-off variants are folded into the generic one, not added beside it.
8. **Delete over deprecate.** Removing a feature removes its code, tests, docs, and config in one PR. Half-removed features are where slop accumulates.
9. **One source of truth per fact.** A constant, a schema, a config value lives in one place and is imported; a second copy is a defect.
10. **Errors surface; they are never swallowed.** No empty catch, no `catch { return null }`, no logging-and-continuing past a state the caller must know about.
11. **Naming.** Full descriptive identifiers; a name says what a thing is, not how it works. The rule lives in `.claude/rules/coding-standards.md`.
12. **Trace callers before changing a contract.** Before changing a signature, schema, or event shape, walk the call graph: the language server's find-references, `rg` for the name, `dependency-cruiser` for the import graph. Update every consumer in the same change.
13. **Unfinished is not dead.** Several features are partly built and not yet wired end to end; Remote Control (driving a session from another device or a phone) is one. Before deleting code that looks unused, check whether a spec, plan, or ADR under `docs/` still calls for it (`rg` the type, function, or module name across `docs/specs`, `docs/plans`, `docs/decisions`, and `docs/architecture/cross-plan-dependencies.md`). If a document owns it, it stays untouched: no comment, no marker in the code. If the unused-export report keeps flagging it, add the path to the tool's ignore list in its config file, where the entry can be removed when the feature lands. Delete only what no document claims.

Rules 2, 4, 9, and 12 are answered by static analysis, not by reading: symbol references, the call graph, the import graph, and the unused-export report. Run the tool, then act on its output.

## Docs

- `docs/specs/` what a feature is · `docs/plans/` how it gets built · `docs/decisions/` ADRs (Type 1 reversible, Type 2 one-way) · `docs/domain/`, `docs/architecture/`, `docs/operations/` reference.
- Skeletons in each folder's `000-*-template.md`, for when you want one. A spec or plan is `draft` or `ready`.
- Link to a heading as an ordinary markdown link (`[Spec-005 §Heading](../specs/005-x.md#heading)`); `lychee` checks links in CI. No line-number citations. When you rename or move a heading, fix every link to it in the same commit. `docs/operations/failure-mode-catalog.md` is the five-item checklist for edits that rename or move things.
- Research scratch lives in `.agents/tmp/` (gitignored); committed docs never link there. `docs/superpowers/` and `docs/archive/` are frozen.
- `docs/backlog.md` lists only work blocked on the outside world.
