# AGENTS.md

Instructions for every AI coding tool working in this repo (Claude Code, Codex, Cursor, Copilot, Aider). Claude Code reads it through `CLAUDE.md`, which imports this file and adds only what is specific to Claude Code. This file holds what applies everywhere; [`packages/AGENTS.md`](packages/AGENTS.md) and [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md) add only what is specific to their areas, so read the one for the code you touch.

## What this is

AI Sidekicks is an agentic coding desktop runtime: one user and their AI sidekicks (Claude Code, Codex) building software in live sessions. The session is the primary object ([ADR-001](docs/decisions/001-session-is-the-primary-domain-object.md)). Three layers: a local runtime daemon (provider processes, git worktrees, terminals, SQLite), a control plane (auth, device directory, encrypted relay, Postgres), and clients (the `sidekicks` CLI first, then the Electron desktop). TypeScript throughout; XState v5; tRPC v11; Zod; Cedar for approval policy; a Rust PTY sidecar on Windows. Apache-2.0.

**Agent in code and docs, sidekick on screen.** The concept is an agent: `AgentDefinition` is a saved one, `Agent` a live one in a session, and identifiers, file names and explanatory prose say agent. "Sidekick" is the brand and the word a person reads: on-screen strings, the `Sidekicks` destination and its `#/sidekicks` addresses, the `sidekicks` CLI, `@ai-sidekicks/*` packages, and the names a provider sees (`sidekicks:codex-<name>`).

Features: [README.md](README.md). What is left to build and in what order: [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md). What has shipped: `git log --oneline --grep 'Plan-'`.

## Commands

pnpm 10.33.2, Node ≥ 24.21. Never `npm` (the workspace uses pnpm's `catalog:` protocol, which npm cannot read).

- `pnpm install` (also installs the git hooks)
- `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build` · `pnpm format`

## How work lands

Branch off `develop` as `<type>/<topic>`, open a PR, squash-merge. CI runs on every PR and reports, and each PR gets one review round from a fresh reviewer subagent; on `develop` CI informs, it never blocks. `main` is the release branch and the only one with required checks. Commit format, types, and scopes: [CONTRIBUTING.md §Commits](CONTRIBUTING.md#commits).

## Rules with a reason

1. **No secrets in the tree.** The pre-commit scan and the CI scan both run; a leaked key cannot be un-pushed.
2. **Never `git commit --no-verify`.** The hook is the secret scan.
3. **Product code (`packages/`, `apps/`) carries no governance identifiers** — no `Spec-NNN`, `Plan-NNN`, `ADR-NNN`, `BL-NNN`, invariant or task ids, links into `docs/`, PR numbers, review history — and no reference-app branding. No tracked file, code or doc, names a reference app. Applied by reading; there is no lint rule and none is to be added.
4. **Git worktrees live under `.worktrees/<name>/`.** Removing one another session is using breaks that session (2026-07-07 incident), so harness removals refuse while it is occupied. `python3 .claude/hooks/worktree-occupancy.py --occupancy <path>` prints the occupants; empty means free. `WORKTREE_REMOVE_ALLOW_OCCUPIED=1` overrides.
5. **No home-made structure checkers.** No source-parsing test suites, census tests or prose-claim gates; a structural rule is a line in a standard tool's config (ESLint, knip, dependency-cruiser) or a sentence in an `AGENTS.md`. Nothing enforces what a document says, how it is worded, or which words appear — no test, no script. 41,000 lines of such tests were deleted on 2026-09-09.

## Engineering rules

This is a greenfield product with no released version and no external users. That sets the bar for how code changes:

1. **Fix in place. No backwards compatibility, no migrations, no deprecation shims.** When a type, schema, table or API changes, change it and every caller in the same PR. A `v2` beside a `v1`, a compat adapter or a data migration is a defect. Kept code is brought forward: its owner, names, comments, types, tests and docs say what it is now; nothing is left in an old shape for a later build to sort out.
2. **Search before you write.** Before adding a helper, type, hook or component, find the existing one (`rg` across `packages/` and `apps/`, the language server's references and definitions) and reuse or extend it. Two functions that do the same thing is a defect. Code two places need lives once, in a module named for what it does, in the package that owns the concept or one both callers import.
3. **Prefer a maintained library over new code.** If a well-maintained dependency already solves the problem, use it. Home-grown parsers, schedulers, validators and utilities are code the project maintains forever. The same holds for provider features: when Claude Code or Codex already does it — a wire verb, a hook, a flag — use that and build only the smallest bridge.
4. **Leave no slop.** No dead code, unused exports, commented-out blocks, placeholder branches, forwarding-only wrappers, or defensive checks for cases that cannot happen. A contract is not a callable API: `packages/contracts` may hold a method's schemas, types and refusal codes before the daemon serves it, and a client may list a method a planned feature will call; a stub, refusing client, status word or placeholder data never stands in for an unbuilt handler. Find dead code with the tools — `knip` for exports and files, `tsc` for locals, the call graph for unreachable functions — and check each hit against rule 13 before removing it. A change is done when the diff holds only what the feature needs.
5. **Tests only where failure is expensive.** Test the critical path, the edge that corrupts data or leaks a secret, the boundary another package depends on. No tests for shape, coverage or wiring; no redundant tests; no test that would still pass with the feature deleted. Tests that prove the same behavior are merged into one that keeps every distinct assertion, wherever you come across them. A test that names a guard calls that guard; for a failure path, confirm a mutation kills the test.
6. **No file is over 900 lines, tests and data included.** Past that, split it at a seam between two concepts; a test file splits by behavior after tests that prove the same behavior are merged. This is an instruction: no lint rule, script or test checks it.
7. **Generic, reusable interfaces.** Components, views, pages, services and stores expose a small typed interface and are built to be composed; a one-off variant is folded into the generic one, not added beside it.
8. **Delete over deprecate.** Removing a feature removes its code, tests, docs and config in one PR; half-removed features are where slop accumulates. A test that fails on behavior that was deliberately removed is deleted, never repaired, and the behavior is never restored to make a test pass.
9. **One source of truth per fact.** A constant, a schema, a config value lives in one place and is imported; a second copy is a defect. A value moves to `packages/contracts` only when a second independently developed surface asserts it, or it is a wire enum or schema; two consumers alone never justify it. A contract is imported from the public module that exports it, by its path under the package's topic folders, `@ai-sidekicks/contracts/<topic>/<module>`; the package has no root entry and no barrel, and `event/version`, `gitflow/shared` and `internal/*` are private to it.
10. **Errors surface; they are never swallowed.** No empty catch, no `catch { return null }`, no logging-and-continuing past a state the caller must know about.
11. **Naming.** Every name follows [Code conventions](#code-conventions).
12. **Trace callers before changing a contract.** Before changing a signature, schema or event shape, walk the call graph (find-references, `rg` for the name, `dependency-cruiser` for imports) and update every consumer in the same change.
13. **Unfinished is not dead.** Several features are partly built, Remote Control (driving a session from another device or a phone) among them. Before deleting code that looks unused, `rg` its name across `docs/specs`, `docs/plans`, `docs/decisions` and `docs/architecture/cross-plan-dependencies.md`; what a document claims stays untouched, with no comment or marker. The unused-code report (`knip.json`) has four exemptions, in the owning workspace, each but the last leaving in the change that builds or imports its consumer:
    - a file kept for an unbuilt consumer: one `ignoreFiles` entry, its exact path (never a directory or glob), with a plain-word comment naming the consumer; it clears only that file, so a chain of unwired files takes one entry each;
    - an export a document claims: a `@consumedBy <plain words>` tag naming no document or task, on each specifier the report flags (a barrelled export flagged at barrel and declaration carries two);
    - a library the design names, installed before any code imports it: one `ignoreDependencies` entry naming in plain words the feature that will import it;
    - an operating-system program code or a test runs, or a runtime's built-in module code or a test imports, which no package installs (`scutil`, `xdpyinfo`, `cloudflare:workers`): one `ignoreBinaries` entry for a program or one `ignoreDependencies` entry for a module, with a comment naming what runs or imports it and why the system or runtime supplies it.

    A screen's tests for an unbuilt wire are deleted in the change that builds the wire. Nothing is wired to quiet the report, and nothing the design requires is deleted to quiet it.

14. **Resource budgets are acceptance criteria.** Memory, processor, disk and network traffic, process count and responsiveness count as much as behavior. Prefer bounded, event-driven work over polling, duplicate state and unbounded queues or caches. For a change that affects them, name the workload and budget first and measure before and after; never claim low overhead or better performance without the numbers.
15. **Record a real dependency choice.** When a library is added, swapped or deliberately not used, say in a sentence or two what was considered and what decided it (maintenance, correctness, API fit, licensing, weight, security, runtime cost), in the owning spec or plan, an ADR for a one-way door, or the PR description. Take the newest release; if it breaks something that worked, step back one release at a time and record what broke. A version a doc pinned is no reason to stay behind.
16. **Validate at real boundaries.** Validation and error handling sit where data crosses in from outside: a provider, a file, the network, another process, a person's input. Inside, typed values are trusted and not re-checked layer by layer.

Rules 2, 4, 9 and 12 are answered by running the tools, not by reading: `knip` over every workspace from the root (`pnpm structure:dead-code`), `dependency-cruiser` only in `apps/desktop`.

## Working style

- A user instruction outranks this file; this file outranks any skill or plugin text. When two instructions conflict, take the reversible reading and say so.
- Do the task asked, and fix in the same PR every bug or defect you or a subagent find while doing it, even outside the files the task names; that fix belongs in the diff alongside the feature (rule 4). A subagent told not to touch a file reports what it found to the lead, who fixes it. Nothing is left for a follow-up: only work blocked outside the repo waits, named in the PR description with what unblocks it, and in `docs/backlog.md` if it outlives the PR.
- Before reporting, audit each claim against a tool result from this session and report only work you can point to evidence for. A failing test or check is yours to investigate and resolve before you report. Every writer and every reviewer also applies the file-naming rule in [Folders by topic](#folders-by-topic) and [Comments and docstrings](#comments-and-docstrings) to each file it wrote or reviewed.
- Proceed without asking for normal development and git work; ask only before an action that could damage the machine or the environment outside this repo.
- Run the package's tests for what you changed, and `pnpm typecheck && pnpm lint` before a PR. Rerun a test only for a new failure.
- A subagent brief names the goal, the files and symbols that already exist, what not to touch, and what done looks like. Split parallel work by non-overlapping file sets: parallel reading is safe, parallel writing conflicts.
- Research scratch goes under `.agents/tmp/<topic>/` (gitignored). A committed document never links there; a finding that matters goes into the document that needs it, with its source.
- When reviewing, report every finding with a severity, unfiltered. Fix every review finding, nitpicks included.
- A design mock is a picture, never source: none of its markup, styles, script, sample data, sizes or figures enter product code or a tracked document. Figures come from data, measurements from the token scale.
- A requirement is never weakened to fit what a provider or a library offers today. Find the mechanism that meets it; a true gap is reported to the person as a gap, never shipped as a smaller requirement, an absence line, or a provider limitation restated as the design.

## Code conventions

All code, every language. Before changing a lint rule, read how each check is scoped in [Desktop Structure §Other Checks](docs/architecture/desktop-structure.md#other-checks).

### Names

- **Full, descriptive identifiers** (`browserWindow` not `win`, `request` not `req`), so comments explain _why_. Short names only in tight idiomatic scopes (`i`/`j` loop indices, `e` in a `catch`, `x`/`y`); never abbreviate a domain entity. A new name in code with a consistent local convention, even an abbreviated one, follows that convention unless you are explicitly asked to rename.
- **One canonical name per concept, within the layer where it lives.** A product or domain concept uses the design's word, and on-screen text uses the design's exact words; an implementation concept keeps its conventional engineering name, never renamed to match screen text. No synonyms inside one concept and layer. Example: the Settings › Runtime page is `runtime` in its folder, component, id, address and label; the process under it is the daemon (`packages/runtime-daemon/`, `callDaemon()`); screen prose calls it the background service.
- **A product screen or page keeps one name end to end:** folder, component, route or destination id, address, navigation label and page heading.
- **An existing name changes only when** its concept is obsolete, the name is inaccurate, the design replaces the concept it names, or [Folders by topic](#folders-by-topic) calls for the rename or a move. Never because a screen name changed, never only to start with a verb, read as a question, put its head noun last or add a prefix, and no suffix is added or removed mechanically. A rename of a TypeScript name goes through the language service's rename; every rename or move updates producer, consumer, contract, tests, docs and tool config in the same change, and a renamed class or token keeps its styling. A word swap needs the same meaning on both sides.
- **Name a thing for what it is,** by its responsibility and owner, never by how it works and never by swapping one word for another. A generic word (`Surface`, `Feature`, `State`, `Act`, `seat`, `slot`, `door`, `plane`, `family`, `deck`, `Host`) never stands in for that; "Control plane" is the real name of `packages/control-plane`. `Console` is no prefix on code structure, only the product's own term. No dumping-ground folders (`utils/`, `util/`, `helpers/`, `common/`, `misc/`, `managers/`); `tests/helpers/` is the one exception.
- **Names read as English.** Things that act (functions, hooks, controls) start with the verb: `takeShell`, `useTakeShell`. Things that hold data are noun phrases, head noun last: `TakeShellAvailability`, `take-shell-availability.ts`. A verb is never forced into a noun. Booleans read as questions: `isHeld`, `canTake`.
- **An interface takes no `I` prefix:** `User`, never `IUser` (ESLint: `@typescript-eslint/naming-convention`).
- **American spelling everywhere:** identifiers, CSS, on-screen text and docs (`color`, `behavior`, `canceled`, `organization`). A spelling a provider's wire sends stays as sent.
- **`shell` means a terminal or command shell.** Electron's main process is `main`; persistent interface chrome is `layout` or `AppShell`.

### File and folder names

A name's case says what the file is responsible for; `.ts` or `.tsx` says only whether it contains JSX (ESLint refuses a `.tsx` with no JSX).

- A React component or page has a PascalCase basename. Working `createElement()` code is never rewritten into JSX to fit a file name.
- A reusable or exported component normally has its own file; a tiny private helper component may stay with its sole owner when extracting it would be ceremony rather than a real reusable boundary.
- A shared component or group owner has a PascalCase folder, holding a small cohesive set of components that share one owner, styling, contracts or infrastructure; never a generic bucket.
- A hook is `useThing.ts` and holds no presentation JSX; that becomes a component when it has a real interface responsibility.
- Every other module is kebab-case, `.tsx` only when it genuinely contains JSX. Every other folder is `kebab-case/`.
- A test keeps its subject's stem and casing: `.test.tsx` only when the test contains JSX, otherwise `.test.ts`. No `.spec` file anywhere. Subject-specific test support sits beside the subject as `*.test-support.ts(x)`; broader helpers live in `tests/helpers/`, named for what they provide, without the suffix.
- `__tests__/` is allowed only in the packages and the repository's tooling, and `__fixtures__/` only in the packages.
- Tool- and framework-required names, generated files and established config file names keep their tool's spelling. Rust files are `snake_case.rs`.
- `index.ts` exists only for an intentional public API: named exports only, and never a barrel chain (an `index.ts` re-exporting another). No `export *` in any authored TypeScript file except `*.d.ts` (ESLint).
- ESLint checks the case of every name (`eslint-plugin-check-file`). Whether a file is a component, whether a reusable or exported component has its own file, and what test support is named for, are checked by reading.

### Folders by topic

For `packages/` and `apps/desktop`. Example paths start inside a package's `src/`, the desktop's `src/` or its renderer root.

- **What a module is and who owns it comes first; the rest of this section serves that.** A lexical scan (a shared prefix, a folder with one module) is a review signal to look, never by itself the reason to move, split or merge, and a settled owner is not overridden because a scan dislikes its path.
- **Modules are grouped by topic, in folders, never by a shared file-name prefix:** in every package, and in the desktop inside every layer, feature and `tests/`. The modules of one domain concept share a `kebab-case/` folder named for it: `daemon/lifecycle.ts` and `daemon/status.ts`, never `daemon-lifecycle.ts` beside `daemon-status.ts`; three `launch-*.ts` helpers of one topic mean a `launch/` folder is missing. This holds at every level, so inside `git/` the worktree modules sit in `git/worktree/`, not as `git/worktree-*.ts`.
- **Names that share a word suggest a missing topic folder only when they belong to one topic,** and a folder counts like a file: `run-page/` beside `runs/` becomes `runs/page/`. The same spelling with a different meaning is no topic (`terminal/emulator/renderer-pool.ts` beside the renderer process; `main/services/daemon/service/`), and neither is a word such as a protocol version (`v4-`).
- **No topic folder is made for one module.** A topic with one module is a file (`compaction.ts`); its second module creates the folder and moves the first into it, in the same change. An established boundary may hold one module: a feature's `hooks/`, `components/`, `services/` and `contributions/` slots, a component's owner folder, a test tier, a folder a tool or the router requires, and an owner the design settled (`store/window/layout/`).
- **A file or folder is named for what it holds, never like its folder and never repeating a word a folder above it already says.** This is a rule, not a review signal: `mcp/mcp.ts`, `daemon/daemon-process.ts` and `shared/daemon/daemon-streams.ts` are defects. The path is read with the name: `daemon/lifecycle.ts`, `jsonrpc/message.ts`, `transcript/runs/groups.ts`, `runs/page/graph/` (not `runs/page/run-graph/`), `provider/driver/codex/commands.ts` (not `provider/driver/codex/provider-commands/`). The one exception: a React component's or hook's file keeps its component's or hook's exact name (`Button/Button.tsx`, `useSessionDirectory.ts`). An identifier keeps its full name, because an import reads it without the path (`daemon/process.ts` exports `DaemonProcess`).
- **A name is the word the domain or the spec uses for what the file holds, never a weaker synonym chosen to dodge a repeat** (`wire`, `core`, `main`, `types`, `envelope` where the spec says message; `partition` for a file of run groups). The JSON-RPC 2.0 spec names a request, a notification and a response, so the file of `JsonRpcMessage` is `message.ts`. A file whose contents no one such word covers holds several independent concepts and splits by them: a Codex file of command-list readers and the compaction call becomes `commands.ts` and `compaction.ts`. A cohesive file is never split because its name repeats its folder.
- **Lint checks only mechanical facts** (case, known path patterns, test names). Topic, repetition and module-count calls need ownership knowledge and are made by reading; no lint rule, script, test or other checker is added for them ([Rules with a reason](#rules-with-a-reason), rule 5).
- **A folder that grows hard to scan splits by sub-topic,** never by kind of code (`types/`, `schemas/`, `constants/`).

### Comments and docstrings

- Prettier's 100-column width (`printWidth`) for code; comments wrap within it.
- A comment is short — one line where one does — and says what the code does and why in plain words, never restating it; otherwise it is deleted. A comment or docstring carries no doc prose: it never quotes or cites the project's design, specs, plans, decisions or reviews ("the design says", "in the design's words", "as the spec writes it"), and holds no task, plan, review or decision prose, no ids, no dates and no history.
- Every exported function, class, component, hook, type and constant carries a `/** … */` docstring of one or two sentences: what it is for, and any contract a caller must know (an error it throws, a unit, an invariant). No `@param` or `@returns` line that repeats the type; no docstring on a private helper whose name says what it does.

### Closed sets of values

No TypeScript `enum` or `const enum` in application or domain code (ESLint refuses one). A closed set is declared once and every consumer derives from it; a second union that mirrors the first is a defect. Use:

- a string-literal union when only the type is needed: `type RunState = "queued" | "running" | "completed" | "failed";`
- an `as const` object and its derived union when the values are needed at runtime: `const RunState = { Queued: "queued", Running: "running" } as const;` with `type RunState = (typeof RunState)[keyof typeof RunState];`
- a discriminated union when each state carries its own data: `{ state: "running"; startedAt: string } | { state: "failed"; error: string }`.

An enum is allowed only where an external, generated or platform contract requires one; it stays at that boundary, behind a file-scoped lint exemption, and is translated there into one of these forms.

## Docs

- `docs/specs/` what a feature is · `docs/plans/` how it gets built · `docs/decisions/` ADRs (Type 1 reversible, Type 2 one-way) · `docs/domain/`, `docs/architecture/`, `docs/operations/` reference.
- Each folder's template file holds an optional skeleton. A new spec or plan starts `draft` and becomes `ready`; existing ones keep their status. A document records what was intended when written: later code changes do not reopen it, change its status or need an audit. Edit one only to make it say something different.
- Link to a heading as an ordinary markdown link (`[Spec-005 §Heading](../specs/005-x.md#heading)`); `lychee` checks links in CI. A doc names code by path and symbol, never by line number or a count a code change breaks (lines, files, call sites, tests). Renaming or moving a heading or file fixes every link and path to it in the same commit (checklist: `docs/operations/failure-mode-catalog.md`).
- A document says what the product will be and carries no history. The current design outranks any older prose: an older phase or tier scheme, dated audit box, amendment log, "previously" sentence or review note is rewritten to the current design or deleted, never kept beside it. History lives in git and `docs/archive/`. No doc claims to be locked, frozen or final, or to outrank a later change.
- Specs, plans and ADRs are each numbered from 001 with no gaps; removing one renumbers every later one in its folder in the same change (file name, title, header number, ids built on it like `CP-010-4`, headings, anchors, references). A spec and its plan do not share a number; each names the other in its header. Numbered series inside a document (phases, tasks, obligations, invariants, decisions, steps) run without gaps and renumber the same way.
- `docs/archive/` is history, never updated or used for current work; anything worth keeping for the record can move there.
- `docs/backlog.md` lists only work blocked on the outside world.

## Project structure

A pnpm workspace built with Turbo, plus two Rust crates.

- `apps/desktop/` — the Electron app (main, preload, React renderer).
- `apps/cli/` — the `sidekicks` command line, bundled into one file; it reaches the daemon only through `client-sdk`.
- `packages/`: `runtime-daemon` (the local daemon and its execution services), `control-plane` (the gated Cloudflare Worker and its Postgres schema runner), `contracts` (protocol contracts, schemas, cross-container types), `client-sdk` (the typed daemon client for the desktop main process and the CLI), `crypto-paseto` (PASETO v4 primitives for auth), `search-index` (the session search index: Tantivy in a Rust Node-API addon only the daemon loads), `search-ranking` (the one fuzzy matcher), `sidecar-rust-pty` (the stdio PTY multiplexer the daemon drives on Windows).
- `tools/` — repository scripts (test runner wrapper, coverage table, mutation shards, pre-commit worktree lock), tested in `tools/__tests__/`.
- `docs/` — see [Docs](#docs), plus `vision.md` and `reference/` (provider wire references).
- `.claude/`, `.codex/` — tool config. `.github/workflows/` — CI, docs checks, secret scan. `patches/` — pnpm patches.
- `.worktrees/`, `.agents/tmp/` — gitignored worktrees and research scratch.
