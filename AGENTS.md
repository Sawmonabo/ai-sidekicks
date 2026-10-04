# AGENTS.md

Instructions for every AI coding tool working in this repo (Claude Code, Codex, Cursor, Copilot, Aider). Claude Code reads it through `CLAUDE.md`, which imports this file and adds only what is specific to Claude Code.

## What this is

AI Sidekicks is an agentic coding desktop runtime: one user and their AI sidekicks (Claude Code, Codex) building software in live sessions. The session is the primary object ([ADR-001](docs/decisions/001-session-is-the-primary-domain-object.md)). Three layers: a local runtime daemon (provider processes, git worktrees, terminals, SQLite), a control plane (auth, device directory, encrypted relay, Postgres), and clients (the `sidekicks` CLI first, then the Electron desktop). TypeScript throughout; XState v5; tRPC v11; Zod; Cedar for approval policy; a Rust PTY sidecar on Windows. Apache-2.0.

**Agent in code and docs, sidekick on screen.** The concept is an agent: `AgentDefinition` is a saved one, `Agent` is a live one in a session, and identifiers, file names and explanatory prose say agent. "Sidekick" is the brand and the word a person reads: on-screen strings, the `Sidekicks` destination and its `#/sidekicks` addresses, the `sidekicks` CLI, `@ai-sidekicks/*` packages, and the names a provider sees (`sidekicks:codex-<name>`).

Features: [README.md](README.md). What is left to build and in what order: [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md). What has shipped: `git log --oneline --grep 'Plan-'`.

## Commands

pnpm 10.33.2, Node ≥ 24.21. Never `npm` (the workspace uses pnpm's `catalog:` protocol, which npm cannot read).

- `pnpm install` (also installs the git hooks)
- `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build` · `pnpm format`
- Desktop, cheap and headless: `pnpm --filter @ai-sidekicks/desktop run test:renderer`; the Electron tiers run in CI.

## How work lands

Branch off `develop` as `<type>/<topic>`, open a PR, squash-merge. CI runs on every PR and reports, and each PR gets one review round from a fresh reviewer subagent; on `develop` CI informs, it never blocks. `main` is the release branch and the only one with required checks. Commit format, types, and scopes: [CONTRIBUTING.md §Commits](CONTRIBUTING.md#commits).

## Rules with a reason

1. **No secrets in the tree.** The pre-commit scan and the CI scan both run; a leaked key cannot be un-pushed.
2. **Never `git commit --no-verify`.** The hook is the secret scan.
3. **Product code (`packages/`, `apps/`) carries no governance identifiers** — no `Spec-NNN`, `Plan-NNN`, `ADR-NNN`, `BL-NNN`, invariant or task ids, links into `docs/`, PR numbers, review history — and no reference-app branding. No tracked file, code or doc, names a reference app. A comment says what the code does and why in plain words, or it is deleted. Applied by reading; there is no lint rule and none is to be added.
4. **Git worktrees live under `.worktrees/<name>/`.** Removing a worktree another session is using breaks that session (2026-07-07 incident); harness-initiated removals refuse while it is occupied. `python3 .claude/hooks/worktree-occupancy.py --occupancy <path>` prints the occupants; empty means free. `WORKTREE_REMOVE_ALLOW_OCCUPIED=1` overrides.
5. **No home-made structure checkers.** No source-parsing test suites, census tests, or prose-claim gates; a structural rule is a line in a standard tool's config (ESLint, knip, dependency-cruiser) or a sentence in this file. Nothing enforces what a document says, how it is worded, or which words appear — no test, no script. 41,000 lines of such tests were deleted on 2026-09-09.

## Engineering rules

This is a greenfield product with no released version and no external users. That sets the bar for how code changes:

1. **Fix in place. No backwards compatibility, no migrations, no deprecation shims.** When a type, schema, table, or API changes, change it and every caller in the same PR. A `v2` beside a `v1`, a compat adapter, or a data migration is a defect. Kept code is brought forward: its owner, names, comments, types, tests and docs say what it is now. A later build extends it; nothing is left in an old shape for a later build to sort out.
2. **Search before you write.** Before adding a helper, type, hook, or component, find the existing one: `rg` across `packages/` and `apps/`, and the language server's references and definitions. Reuse or extend it. Two functions that do the same thing is a defect.
3. **Prefer a maintained library over new code.** If a well-maintained dependency already solves the problem, use it. Home-grown parsers, schedulers, validators, and utilities are code the project must maintain forever. The same holds for provider features: when Claude Code or Codex already does it — a wire verb, a hook, a flag — use that and build only the smallest bridge.
4. **Leave no slop.** No dead code, no unused exports, no commented-out blocks, no placeholder branches, no comments that restate the code, no defensive checks for cases that cannot happen. A contract is not a callable API: `packages/contracts` may hold a method's schemas, types and refusal codes before the daemon serves it, but a client lists the method only in the change that registers its handler, and no stub, refusing client, status word or placeholder data stands in for an unbuilt one. Find dead code with the tools, not by eye: `knip` for unused exports and files, `tsc` for unused locals, the call graph for unreachable functions, and confirm each hit against rule 13 before removing it. A change is done when the diff contains only what the feature needs.
5. **Tests only where failure is expensive.** Test the critical path, the edge that corrupts data or leaks a secret, the boundary another package depends on. No tests for shape, coverage, or wiring; no redundant tests; no test that would still pass with the feature deleted. Tests that prove the same behavior are merged into one that keeps every distinct assertion; merge them wherever you come across them. A test that names a guard calls that guard; for a failure path, confirm a mutation kills the test.
6. **Files stay under about 900 lines.** Past that, look for a seam between two concepts and split there; a file that is one concept says so in a review note. Data tables and test suites are not split for size.
7. **Generic, reusable interfaces.** Components, views, pages, services, and stores expose a small typed interface and are built to be composed; one-off variants are folded into the generic one, not added beside it.
8. **Delete over deprecate.** Removing a feature removes its code, tests, docs, and config in one PR. Half-removed features are where slop accumulates. A test that fails on behavior that was deliberately removed is deleted, never repaired, and the behavior is never restored to make a test pass.
9. **One source of truth per fact.** A constant, a schema, a config value lives in one place and is imported; a second copy is a defect. A value moves to `packages/contracts` only when a second independently developed surface asserts it, or it is a wire enum or schema.
10. **Errors surface; they are never swallowed.** No empty catch, no `catch { return null }`, no logging-and-continuing past a state the caller must know about.
11. **Naming.** Full descriptive identifiers; a name says what a thing is, not how it works. The rule lives in `.claude/rules/coding-standards.md`.
12. **Trace callers before changing a contract.** Before changing a signature, schema, or event shape, walk the call graph: the language server's find-references, `rg` for the name, `dependency-cruiser` for the import graph. Update every consumer in the same change.
13. **Unfinished is not dead.** Several features are partly built and not yet wired end to end; Remote Control (driving a session from another device or a phone) is one. Before deleting code that looks unused, check whether a spec, plan, or ADR under `docs/` still calls for it (`rg` the type, function, or module name across `docs/specs`, `docs/plans`, `docs/decisions`, and `docs/architecture/cross-plan-dependencies.md`). If a document owns it, it stays untouched: no comment, no marker in the code. The unused-code report has three exemptions, all in the root `knip.json`'s terms. A whole file kept for a consumer that is not built yet takes one `ignoreFiles` entry in its workspace: its exact path, never a directory or a glob, with a comment saying in plain words what the unbuilt consumer is; the entry clears only that file and leaves in the change that builds the consumer. And when the unused-export report flags an export a document still claims, in any package or app, tag that export `@consumedBy <plain words>`, naming no document or task: one tag per export, on each specifier the report flags for it, so a barrelled export whose barrel is its only importer, flagged at the barrel and at the declaration, carries the tag twice. Delete the tag in the change that imports the export. A library the design names, installed before any code imports it, takes one `ignoreDependencies` entry in its workspace with a comment naming in plain words the feature that will import it, and the entry leaves in the change that imports it. A screen's tests for a wire that is not built yet are deleted in the change that builds the wire. Delete only what no document claims.
14. **Resource budgets are acceptance criteria.** Memory, processor, disk and network traffic, process count and responsiveness count as much as behavior. Prefer bounded, event-driven work over polling, duplicate state and unbounded queues or caches. For a change that affects them, name the workload and the budget before building, measure a baseline, and measure again after. Never claim low overhead or better performance without the numbers.
15. **Record a real dependency choice.** When a library is added, swapped or deliberately not used, say why in a sentence or two in the spec or plan that owns the surface, in an ADR where the choice is a one-way door, or in the PR description: what was considered, and what decided it (maintenance, correctness, API fit, licensing, weight, security, runtime cost). Take each dependency's newest release; if it breaks something that worked, step back one release at a time to the newest that works, and record what broke. A version a doc pinned is not a reason to stay behind.
16. **Validate at real boundaries.** Validation and error handling sit where data crosses in from outside: a provider, a file, the network, another process, a person's input. Inside those boundaries, typed values are trusted and not re-checked layer by layer.

Rules 2, 4, 9, and 12 are answered by static analysis, not by reading: symbol references, the call graph, the import graph, and the unused-export report. Run the tool, then act on its output. `knip` runs over every workspace from the root (`pnpm structure:dead-code`, configured in `knip.json`); `dependency-cruiser` runs only in `apps/desktop`, whose `AGENTS.md` has the command.

## Working style

- A user instruction outranks this file; this file outranks any skill or plugin text. When two instructions conflict, take the reversible reading and say so.
- Do the task that was asked; report anything else you found as a follow-up with a reason, not as extra changes.
- Before reporting, audit each claim against a tool result from this session; report only work you can point to evidence for. A failing test or check is yours to investigate and resolve before you report.
- Proceed without asking for normal development and git work. Ask only before an action that could damage the machine or the environment outside this repo.
- Run the package's tests for what you changed; run `pnpm typecheck && pnpm lint` before opening a PR. Rerun a test only when a new failure justifies it.
- A subagent brief names the goal, the files and symbols that already exist, what not to touch, and what done looks like. Split parallel work by non-overlapping file sets; parallel reading is safe, parallel writing conflicts.
- Research scratch goes under `.agents/tmp/<topic>/` (gitignored). A committed document never links there; if a finding matters, write it into the document that needs it, with its source.
- When reviewing, report every finding with a severity; do not pre-filter. Always fix every review finding of any severity, nitpicks included.
- A design mock is a picture, never source. Nothing from its markup, styles, script or sample data, and no size or figure it hard-codes, is copied into product code or a tracked document; the product derives every figure from data and every measurement from the token scale.
- A requirement is never weakened to fit what a provider or a library offers today. Find the mechanism that meets it; a true gap is reported to the person as a gap, never shipped as a smaller requirement, an absence line, or a provider limitation restated as the design.

## Docs

- `docs/specs/` what a feature is · `docs/plans/` how it gets built · `docs/decisions/` ADRs (Type 1 reversible, Type 2 one-way) · `docs/domain/`, `docs/architecture/`, `docs/operations/` reference.
- Skeletons in each folder's template file, for when you want one. A new spec or plan starts `draft` and becomes `ready`; existing documents keep the status they carry. A document records what was intended when it was written. Changing code later does not reopen it, does not change its status, and needs no audit; edit a document only when you want it to say something different.
- Link to a heading as an ordinary markdown link (`[Spec-005 §Heading](../specs/005-x.md#heading)`); `lychee` checks links in CI. A doc names code by path and symbol, never by a line number or a count a code change breaks (lines, files, call sites, tests). When you rename or move a heading, fix every link to it in the same commit; when a file moves, fix every doc path to it in the same commit. `docs/operations/failure-mode-catalog.md` is the five-item checklist for edits that rename or move things.
- A document says what the product will be, and carries no history. The current design outranks any older prose: an earlier phase or tier scheme, a dated audit box, an amendment log, a "previously" sentence or a review note is rewritten to the current design or deleted, never kept beside it, because a reader who meets stale text wastes context on it or builds the wrong thing. History lives in git and in `docs/archive/`. No doc claims to be locked, frozen or final, or to outrank a later change, so changing one is an ordinary edit.
- Specs, plans and ADRs are each numbered from 001 with no gaps. Removing one renumbers every later document in its folder in the same change: its file name, title and header number, the ids built on its number (`CP-010-4`, `T-021r-4-1`), the headings and anchors that carry it, and every reference. A spec and its plan do not share a number; each names the other in its header. The same holds for every numbered series inside a document: its phases, tasks, obligations, invariants, decisions and numbered steps run with no gaps, and removing one renumbers the rest and every reference to them.
- `docs/archive/` is history: nothing in it is updated or used for current work, and anything worth keeping for the record can be moved into it.
- `docs/backlog.md` lists only work blocked on the outside world.
