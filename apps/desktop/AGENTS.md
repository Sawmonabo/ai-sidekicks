# apps/desktop — structure rules

Binding for every change under `apps/desktop/`, in any tool. Governing docs: `Spec-023 §Console Design (Meridian)`, `Spec-023 §Console Libraries`, `Spec-023 §Console Test Tiers`, and Plan-023 Phase 1B and Phase 1C. Repo-wide conventions are in the repo-root `AGENTS.md`; this file adds only what is specific to this package.

## Mechanical gates

**A structural rule lives in one of the three configs below or in this file. No test reads source text.**

Each runs under `pnpm --filter @ai-sidekicks/desktop`.

| Script | Config | Catches |
| --- | --- | --- |
| `structure:dead-code` | `knip.json` | files, exports, types, and dependencies no entry point reaches |
| `structure:layering` | `.dependency-cruiser.mjs` | cycles, orphans, process-boundary breaks, upward edges against the console DAG |
| `lint` | `eslint.config.mjs` | the import bans, the console's wire-instant and exported-collection bans, and the eight rules below |

`structure` runs both legs locally; CI runs them as two Turbo tasks with `--continue`, so one red leg never hides the other's findings.

The ESLint rules that carry this file's structural claims. Each states its own scope: a rule is only as strong as the file set it matches, and a lifted selector is stated here rather than discovered in the config.

1. The preload bridge is read off the global only in `console/bridge/live-bridge.ts`; every surface above takes it from `BridgeProvider`'s context, which calls `readInstalledBridge` there. Five spellings — `window.sidekicks`, `globalThis.sidekicks`, the cast form `(window as { sidekicks?: … }).sidekicks`, the computed key `globalThis["sidekicks"]`, and the destructure `const { sidekicks } = window` — are banned across the whole renderer, and lifted for its test files, which install a fixture bridge on the global as the substitution seam. Four legacy Tier-1 modules read the bridge directly and are exempted BY NAME so the count is frozen: `session-members/participant-roster.tsx`, `session-members/invite-accept-view.tsx`, `session-bootstrap/SessionBootstrap.tsx`, and `runtime-node-attach/attach-request.ts`; the first three read `window.sidekicks.daemon` with no existence check, so a preload that failed to install throws inside their render, and the migration is to take the bridge from context. An ALIAS — `const w = window; w.sidekicks` — evades every selector and is rejected in review.
2. No `setInterval` anywhere in renderer source, in either spelling — the bare global and `window` / `globalThis`-qualified.
3. No `export default` outside the package-root tool configs, which their tools load by default export. Off for `**/*.d.ts`, where the `export default` inside an ambient `declare module` is how a default-exporting virtual module is typed.
4. No module-level `let` in shipped renderer source. Lifted for `*.test.{ts,tsx}` and `*.test-support.{ts,tsx}`: a `let` reassigned in `beforeEach` is the standard Vitest shape and holds no state anything else can reach.
5. `spawn` from `node:child_process` only in `test/helpers/electron-child.ts` — the static import, the dynamic `import()`, and the `require` form alike, across `test/**`, `src/main/**`, and `scripts/**`. `spawnSync` is untouched: it settles before the statement after it and leaves no child to own.
6. `toMatchScreenshot` only in `test/console/screenshot/settled-capture.ts` and in `test/console/screenshot/frame.test.tsx`, the one probe that asserts the matcher REJECTS and cannot be written without naming it.
7. A relative `.css` import only from the owning directory's `index.ts` or a lazily-loaded chunk root (`*-body.{ts,tsx}`). Relative specifiers only — a vendor sheet reached by package specifier has no owning directory here to enter through and is outside the rule.
8. No directory `import.meta.glob` under `src/`: the literal carries a `*`, so a raw read of one named module is untouched.

What lint does not carry: one component per `.tsx` (§Module shape) is a review rule. No ESLint rule states it — `react-refresh/only-export-components` checks a different property, that a module exporting a component exports only components, which is a Fast Refresh constraint and not a count.

The dead-code gate's one exemption is per SYMBOL: an export tagged `@consumedBy T-023p-1C-<n>` is excluded, and a symbol no task will name is deleted rather than tagged. Tag the specifier knip reports, and delete the tag in the PR that imports the symbol.

## Layout — what belongs in each directory

| Directory | Holds |
| --- | --- |
| `src/main/` | Electron main process: window, protocol, menu, supervision |
| `src/preload/` | `contextBridge.exposeInMainWorld` only — no logic, no branching |
| `src/shared/` | Types and pure functions two or more of main / preload / renderer need; imports contracts only |
| `src/renderer/src/console/` | The Meridian console |
| `src/renderer/src/<family>/` | Another plan's renderer subtree; the console imports these through no path |
| `build/` and `scripts/` | Executables run during `pnpm build`, and executables invoked by name from a package script |
| `test/` | Cross-process suites, `test/helpers/`, and the console tiers under `test/console/<tier>/` |

There is one shared layer: `src/renderer/src/shared/` is not created; a renderer-wide helper lives in the lowest console family that needs it.

No console directory holds more than 42 modules a reader has to hold at once — hand-written, excluding co-located tests and the directory's own door. A directory at the ceiling states in its header why it is one reading; the remedy is a seam, never a larger number.

## Import boundaries

- Renderer source never imports Electron, Node builtins, the daemon or control-plane packages, or any path under `main/` or `preload/`. Add a new ban in `eslint.config.mjs`, never anywhere else.
- Main and preload never import from `src/renderer/`. A value both sides need goes in `src/shared/` and is imported by both, never mirrored by hand.
- The console families form a DAG, low to high: `core → tokens → routing → primitives → store / persistence → bridge → seats → palette → frame → view families`. A family imports any family below it and none above it; an upward edge fails `structure:layering`, and the fix is to hoist the symbol down to the lowest family that needs it.
  - `core/` is the floor and imports no console family. Read the directory for its residents rather than a roster written here.
  - `seats/` holds the contracts through which view families hand each other bodies: the pane registry and chrome, the composer seat, sidebar sections, the row and card slots. Nothing there holds a body.
  - A body not on the flagship first paint registers through a LOADER, `body: () => import("./<name>-body.js")` exporting `Body`, rather than the `render` form the entry graph carries.
  - A VIEW family is any console directory that is neither a layer family above nor a composition site (`COMPOSITION_ROOT_FILES` in `.dependency-cruiser.families.mjs`, plus the files directly under `panes/`).
  - View families are SIBLINGS: one never imports another, and `panes/` is flat — a pane body lives in `<family>/pane/`. Hoist a shared contract into `seats/`, or into the lowest layer family that needs it.
- The console reaches `src/shared/` through the layer family that owns the concern, `core/` today, and never from a view family.
- The console imports no plan-owned renderer subtree whose owner mounts into it (`timeline/`, `usage-meters/`, `run-controls/`, `provider-accounts/`, `sidekick-definitions/`, `mcp-governance/`); those reach the frame by calling `registerConsoleSurface`, which is the one mount door — a second door for the same surface is rejected. A later mounted page joins the list in `.dependency-cruiser.mjs`.
- The console never re-authors or moves a body another plan owns.

## Shared code

- A helper used by two modules is hoisted on the second use. Homes: cross-process → `src/shared/`, cross-family → the lowest family in the DAG, cross-test → `test/helpers/` and `test/console/`.
- One implementation per job. Before adding a formatter, parser, walker, registry, clock, adapter, scheduler, or refusal constructor, grep the tree, then the `node:` standard library.
- Two sides of one seam (producer and consumer, encoder and decoder) share a module. Never two copies of one regular expression or normalization.

## Chokepoints

- **Figures:** `console/primitives/figures/wire-figures.ts` is the only module that formats a wire value — strings verbatim in mono, quantities through `Intl`, bytes scaled by 1024. Which `Intl` instances are held, and under what cap, is `intl-formatter-cache.ts`.
- **Persistence:** every durable write goes through `console/persistence/` and its closed value-class enumeration, and one byte-measurement function serves every cap. Drafts never reach it.
- **Cost:** every cost figure comes from the committed-spend read; the renderer sums nothing.
- **Refresh:** every refresh goes through `console/store/read/refresh-scheduler.ts`.
- **Readings:** a READING is one class that publishes what a surface reads off it _and_ holds the daemon connection. That same class carries the refresh scheduler and the two `ReadTriggerTarget` members a trigger set wires — `triggeringEventKinds` and `requestRead` — so a reading is always one somebody can ask again. A class that publishes only what an act settled holds neither and is not a reading.
- **Daemon calls:** a surface reaches the daemon through `callDaemon` (`console/bridge/daemon/daemon-reply.ts`), which parses the reply against the method's registered schema and answers `served` or `refused`; a surface never parses a wire value itself. A suite that answers one method spreads a real bridge through `console/bridge/fixture/call-plane/`'s `withDaemonCall` / `withDaemonSubscribe`, and that namespace spread is written nowhere else — a suite composing its own is a second door.
- **Markup:** `console/ledger/cards/markdown/nodes/MathBlock.tsx` is the console's one `dangerouslySetInnerHTML` site, because KaTeX's whole interface is a markup string. Everything else the console renders arrives as data; a second occurrence anywhere under `console/` is rejected.
- **Scroll:** `console/ledger/frame/scroll/scroll-chokepoint.ts` is the only module that writes a scroll offset, and every write names its caller so two in one frame can be arbitrated. No `scrollTop` write outside it, and no `scrollIntoView` at all — a glide through the chokepoint replaces it.

## Module shape

- Named exports only; the package-root tool configs are the sole `export default`, because their tools load one.
- Every console family carries exactly one `index.ts`, its family door. Cross-family imports go through it, intra-family imports are deep, and a door reaching another family's door fails `structure:layering`.
  - A door line exists for a production reader: tag it with the task that will import it, or delete it and let its tests read the declaring module.
  - A sub-module directory may carry its own `index.ts`, publishing to its own family only; the family door re-exports from the module that DECLARES a symbol, never through an inner barrel. A sub-module no sibling takes from carries no door at all.
  - A door is an edge to every module it re-exports from, so a name inside a tightly coupled family is held off its own door and its one reader takes it by its own specifier. That deep edge is the remedy, never a shim or a wider door; no view family reads `frame/index.ts` without closing a cycle through `families.ts`.
- A stylesheet enters through the barrel of the directory that OWNS it, and through no component: reaching into a directory that carries a door of its own puts that surface's rules on the initial document for every session that never opens it.
- **One class, one owning sheet.** A class two sheets declare at equal specificity is resolved by load order, so which family's rules win depends on which pane a session opened first — and lazily loading one of the two re-lays-out a surface that never imported it. When a class is found in two sheets the fix is always to give it one owner and never to keep both; which sheet owns it is decided by whether the move would COPY a multi-declaration treatment. If it would, the class's box moves up beside that treatment; if the rule being moved is the console's two-line focus-ring idiom, it moves down to the sheet that declares the box it rings.
  - **A primitive owns every rule that names its class**, including its variants. A family that needs a look the primitive lacks EXTENDS the primitive — a `--variant` modifier or a `data-*` attribute declared in the primitive's own sheet and exported through its door, or a custom property the primitive reads and the composing sheet sets on ITS OWN class — and never declares the primitive's class in a family sheet, not even as the subject of a descendant selector. The property form is exact where a DESCENDANT selector was: it reaches the same elements, and when two containers nest it is decided by proximity rather than by source order. It is not exact where a CHILD combinator was — a custom property inherits down the whole subtree where `>` matched one level — so a `>` conversion widens, and the widening is checked against every producer of the class before it lands.
  - **A family-scoped class carries the family prefix** (`meridian-<family>-…`), and an `__element` belongs to the sheet that declares its block. A class used by two families is either genuinely shared and reached through the owner's door, or it is two classes and the borrower renames. A borrower's rename is checked against the RECEIVING sheet's own classes first: a sheet may declare more than one block, so the name being moved in can already be taken, and two rules merged under one name are resolved by source order exactly as two sheets are — invisibly, because a census that reads across sheets finds nothing.
  - Inside a family, a modifier lives in the sheet of the thing it modifies; the other sheets compose it.
- Every stylesheet reads only custom properties the console itself defines: a `var(--…)` naming a token no sheet declares resolves to nothing and the declaration is dropped, which renders as a missing colour rather than as an error. The one exception is a DOOR — a property a primitive reads with an explicit fallback, `var(--meridian-figure-wire-color, inherit)`, which is undefined by design until a composing sheet sets it and never resolves to nothing. A door carries a fallback or it is a bug. Review rule — no tool in this package lints CSS (`stylelint` is the standard-tool home for it and is not adopted).
- `.tsx` files are PascalCase, one component each; `.ts` modules are kebab-case, named for the noun they own (`-store`, `-registry`, `-adapter`).
- Full descriptive identifiers; single- and few-letter names only for loop indices, `catch` bindings, and coordinates.

## State and views

- Stateful logic is an encapsulated class with private fields. Module-level `let` / `Map` / `Set` singletons are rejected.
- React components are function components that render. Effects, subscriptions, derivations, and store construction live in a class or a hook, never in a render body.
- A closed set is declared once and every consumer derives from it, never a second union with a comment saying it mirrors the first.
- **One store never holds another store's flag.** Window state and session state are two stores on purpose — one per window, one per open session — and a flag copied across that line is a second record of one fact, the one the reconnect path cannot heal. Neither store imports the other (`console-store-isolation` in `.dependency-cruiser.mjs` refuses the edge in both directions, at any depth — it resolves the specifier to a real path, where a `no-restricted-imports` group has to enumerate the relative spellings and stops at the depths that existed when it was written); the registry, the hooks, and the schedulers above them are where the two are composed. No member name is declared by both store states.

## Console design

Neither rule below has a mechanical gate: one reads colour values out of stylesheets and the other reads the shape of a sentence, and both answers are judgments a checker gets wrong in the direction that costs the most — a finding about text nobody reads. They are held here, and in review.

- **Two hues carry attention, and a third is never added.** Amber means a person is needed; red means something failed. Every attention colour is an `ATTENTION_TOKENS` entry in `tokens/palette.ts`, and the brand accent is the one desaturated cyan reserved for interactive affordances. A family stylesheet never paints an attention treatment from a hex, a named colour, or a raw `oklch()` of its own — that is how a third hue actually arrives, one green tick at a time. A raw `oklch(0% 0 0 / …)` in a `box-shadow` is an opacity rather than a hue and is not this rule's subject.
- **Copy is sentence case, and it neither exclaims nor celebrates.** A receipt states what happened. No exclamation mark, no congratulation, and no Title Case run of three or more words — a heading written as a label reads as a different product beside the twenty calm rows above it.

## Executables

- Every file under `scripts/**` and `build/**` is TypeScript, run under `node --experimental-strip-types`, and typechecked by `tsconfig.scripts.json` or `tsconfig.build.json`. No `.js`, `.mjs`, or `.cjs` executable, and no hand-written `.d.mts`.
- A file that neither `pnpm build` runs nor a package script invokes by name belongs in `src/`.

## Tests

- Co-located `*.test.{ts,tsx}` beside the module for `console/`, `shell/`, `src/main/**`, `build/**`, and `scripts/**`. No new `__tests__/`; the three legacy renderer families keep theirs.
- Helper tests live in `test/helpers/` beside their helpers, in the `main-unit` project. The console tiers live under `test/console/<tier>/`, one Vitest project each, globs disjoint.
- Shared scaffolding lives once, one home per ROLE: cross-process roles in `test/helpers/`, console roles in the flat files of `test/console/`. A tier that hand-rolls a role another tier already has is rejected.
- A test never reimplements the rule it checks and never drives a stand-in for the module under test; import the real one. Every clean result has a negative control that fails.
- A screenshot is taken through `test/console/screenshot/settled-capture.ts` and no other way. `captureSettled` refuses a tree still carrying the pending marker; a mount never waits for a deferred body itself, and a per-spec wait is rejected.
- Every test that launches Electron goes through `test/console/electron-harness.ts` (Playwright tiers), `test/helpers/electron-probe.ts` (smoke), or `test/helpers/gc-probe.ts` (GC), which set `SIDEKICKS_UNOBTRUSIVE_WINDOWS=1` so a test build never reveals a window, takes focus, or switches Spaces. A `show()` / `showInactive()` / `focus()` call outside `src/main/window-reveal.ts` is rejected.
- A spawned child's lifetime belongs to the test, never to a timer: `test/helpers/electron-child.ts` registers the kill on `onTestFinished`, and a spawner's own deadline fires before its enclosing per-test budget.
- Lanes verify with `pnpm --filter @ai-sidekicks/desktop run test:changed <base-ref>` plus the files they authored, and `structure`; the aggregate `test` script and the Electron tiers are CI's. That base ref is the first argument of `scripts/test-changed.ts`; no ref, or a file no project claims, exits `2`.

## Config single-sourcing

- One value, one home: budgets and their unit factors in `test/console/budget/budgets.json`, caps in `console/core/constants/`. A threshold restated in a test that also lives in a JSON file is rejected.
- A new Vitest project lands with all five of `vitest.config.ts`, a `test:<project>` script, a Turbo task carrying `inputs`, a line in the aggregate `test` script, and a line in `.github/workflows/ci.yml`'s desktop step — all five or none, a deliberate omission recording its reason beside the registration. `exclude` replaces Vitest's default rather than extending it; spread the default in.
- The aggregate `test` script and the CI desktop step run the tiers in the same order, which is load-bearing: `build`, `build:smoke`, and `build:fixtures` all write `out/**`.
- A new `tsconfig*.json` reaches `typecheck` in the same commit, and no two configs write to one `outDir`. A `tsconfig` no script and no `references` entry reaches is deleted.
- The growth slate has two homes that move together: `Plan-023 §Console growth slate` and `console/bridge/growth-port/growth-slate.ts`. A PR that adds, removes, or re-statuses a row flips both in the same diff — a review obligation, since the claim spans a document this package's tools do not read.

## Budgets

- A budget marked `enforced` is reachable from the aggregate `test` script _and_ from a CI job, and its `measuredBy` names a harness holding the subject it bounds. Unwired, its status is `n/a` naming the wiring task, never `enforced` and unrun.
- Every console PR runs every tier whose subject is in-tree; an absent subject is reported `n/a`, never skipped silently.
- Every bounded wait inside a launching tier's body draws on that tier's body allowance through `boundedMs`, so the first wait that cannot fit fails with its own sentence rather than under Vitest's clock. A wait carrying its own literal is rejected.

## Pre-PR self-audit

1. `pnpm --filter @ai-sidekicks/desktop lint typecheck test structure` clean; `pnpm -w exec eslint .` clean.
2. Every new helper name grepped for a prior implementation — hoist instead of writing the second one.
3. No file over 900 lines without a review note.
4. Every new family: one `index.ts`, cross-family imports through doors, no edge against the DAG; every new constant in `console/core/constants/` with its rationale.
