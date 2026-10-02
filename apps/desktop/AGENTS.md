# apps/desktop — structure rules

Binding for every change under `apps/desktop/`, in any tool. Repo-wide conventions are in the repo-root `AGENTS.md`; this file adds only what is specific to this package.

## No governance references in code

The rule on governance identifiers is AGENTS.md rule 3; it applies to every file in this package.

## Launching

`pnpm --filter @ai-sidekicks/desktop dev` runs the app against the renderer's dev server. Arguments after `--` reach the app: `-- --fixture <scenario>` plays a scenario from `fixtures/index.ts`, and `--session <session-id>` added to it opens that scenario's session. An unknown scenario, a missing value or a session the scenario does not hold stops the launch before any window opens. The development build and `build:fixtures` carry the scenarios; a release build refuses `--fixture`.

## Mechanical gates

**A structural rule lives in one of the three configs below or in this file. No test reads source text.**

Each runs under `pnpm --filter @ai-sidekicks/desktop`.

| Script | Config | Catches |
| --- | --- | --- |
| `structure:dead-code` | the root `knip.json`, this package's workspace | files, exports, types, and dependencies no entry point reaches |
| `structure:layering` | `.dependency-cruiser.mjs` | cycles, orphans, process-boundary breaks, edges against the import direction, and one feature importing another |
| `lint` | `eslint.config.mjs` | the import bans, the renderer's wire-instant and exported-collection bans, and the rules below |

`structure` runs both legs locally; CI runs them as two Turbo tasks with `--continue`, so one red leg never hides the other's findings.

The ESLint rules that carry this file's structural claims. Each states its own scope: a rule is only as strong as the file set it matches, and a lifted selector is stated here rather than discovered in the config.

1. The preload bridge is read off the global only in `services/platform/live-bridge.ts`; every surface above takes it from `PlatformBridgeProvider`'s context, which calls `readInstalledBridge` there. The fixture launch the preload exposes is read there too, by `readFixtureLaunch`, which only `app/fixture-composition.ts` calls. Five spellings — `window.desktopBridge`, `globalThis.desktopBridge`, the cast form `(window as { desktopBridge?: … }).desktopBridge`, the computed key `globalThis["desktopBridge"]`, and the destructure `const { desktopBridge } = window` — are banned across the whole renderer, and lifted for its test files, which install a fixture bridge on the global as the substitution seam. An ALIAS — `const w = window; w.desktopBridge` — evades every selector and is rejected in review.
2. No `setInterval` anywhere in renderer source, in either spelling — the bare global and `window` / `globalThis`-qualified.
3. No `export default` outside the package-root tool configs, which their tools load by default export. Off for `**/*.d.ts`, where the `export default` inside an ambient `declare module` is how a default-exporting virtual module is typed.
4. No module-level `let` in shipped renderer source. Lifted for `*.test.{ts,tsx}` and `*.test-support.{ts,tsx}`: a `let` reassigned in `beforeEach` is the standard Vitest shape and holds no state anything else can reach.
5. `spawn` from `node:child_process` only in `tests/helpers/electron-child.ts` — the static import, the dynamic `import()`, and the `require` form alike, across `tests/**`, `src/main/**`, and `scripts/**`. `spawnSync` is untouched: it settles before the statement after it and leaves no child to own.
6. `toMatchScreenshot` only in `tests/screenshot/settled-capture.ts`, the one module that writes a capture. A never-saved `page.screenshot({ save: false })` read is a measurement rather than a capture and is outside the rule, which names the matcher.
7. A `.css` import (relative or `@renderer/`) reaches only a sheet in the importing file's own folder, except from a lazily-loaded chunk root (`*-body.{ts,tsx}`) and `main.tsx`. A component imports its own sheet (`X.tsx` imports `./X.css`); a sheet that styles several components of one feature is imported by the feature's top view or chunk root; a global sheet in `styles/` is imported by `main.tsx`. Which file in a folder imports the sheet is a review point, not a lint one. A vendor sheet reached by package specifier is outside the rule.
8. No directory `import.meta.glob` under `src/`: the literal carries a `*`, so a raw read of one named module is untouched.
9. No `toMatchSnapshot`, `toMatchInlineSnapshot`, or `toMatchFileSnapshot`, in the property and the computed-key spelling alike. This package's Vitest runs resolve `UPDATE_SNAPSHOT=all` so the screenshot tier writes capture aids rather than gating on them (see Tests below), and under that mode a text snapshot rewrites itself and passes instead of failing — a green assertion that asserts nothing. Assert the value. Every directory `lint` reads — `src/**` (`src/main/**`, `src/preload/**`, and `src/shared/**` included, through the widest `src` block), `tests/**`, `scripts/**`, `build/**`, and `vitest/**` — because the `main-unit` project's `include` entries reach outside the renderer and `tests/**` and run under the same mode.
10. The file sections, in `src/renderer/src/**` only, co-located tests included. Exported types and interfaces, then the exported class, then the exported function, then everything private. Only the EXPORTED forms are ranked: a non-exported declaration matches no group, so all of them share one bucket held last and left in source order — which is what keeps the "private type directly above its one helper" exception followable rather than merely written down. A module-level constant is NOT positioned: the rule has no variable selector and treats every `const` as a partition boundary it moves nothing across, so where a constant sits is convention and the constants a file already has stay where they are.
11. The class order, in the same file set: fields (including index signatures, static blocks, and accessor and function properties), constructor, public methods, then everything else. An accessor ranks with the methods of its own accessibility, since this tree writes `get` after the constructor; `protected` ranks with `private`, because the line the four sections draw is the externally reachable surface against everything else. An absent accessibility keyword reads as public and a `#`-hash member reads as private, so neither half needs an explicit modifier to be classified.
12. Window security, across `src/main/**`. No `new BrowserWindow`, `BaseWindow` or `WebContentsView` outside `src/main/windows/window.ts`, the window factory that holds the one locked `webPreferences` block. `contextIsolation`, `sandbox` and `webSecurity` are written only as the literal `true`, and `nodeIntegration` and `nodeIntegrationInWorker` only as the literal `false`, so a variable in their place is refused too. That the shipped window really carries these settings is proved at run time, by the window test and the smoke launch.

Rules 10 and 11 sort NOTHING within a section — the claim is the order of the sections, never an alphabet — and they add and remove no blank line. The structure-enforcement axis admits two libraries: `eslint-plugin-perfectionist`, with no rule of it beyond these two enabled, and `eslint-plugin-check-file`, which the root `eslint.config.mjs` applies to file and folder names.

What lint does not carry: a reusable or exported component in its own file (see [Desktop Structure](../../docs/architecture/desktop-structure.md#naming)) is a review rule. No ESLint rule states it — `react-refresh/only-export-components` checks a different property, that a module exporting a component exports only components, which is a Fast Refresh constraint and not a count.

The dead-code gate has two exemptions. Per SYMBOL: an export tagged `@consumedBy <reason>` is excluded, and a symbol nothing will import is deleted rather than tagged. Tag the specifier knip reports, and delete the tag in the PR that imports the symbol. Per FILE: a whole file kept for a consumer that is not built yet takes one `ignoreFiles` entry in this package's workspace of the root `knip.json`, the exact path with a comment saying in plain words what the unbuilt consumer is, never a directory or a glob. An entry clears only the file it names, so a chain of unwired files takes one entry per file. The entry leaves in the change that builds its consumer. Nothing is wired to quiet the gate, and nothing the design requires is deleted to quiet it.

The layering gate's `no-orphans` rule has the same per-file allowance, for a kept file that imports nothing and that nothing imports yet: its exact path, anchored, in that rule's `pathNot` in `.dependency-cruiser.mjs`, with the same comment as its `ignoreFiles` entry, never a directory or a pattern. It leaves in the same change as the `ignoreFiles` entry.

## Structure

The renderer root `src/renderer/src/` holds `app/` (composition and bootstrap), `layout/` (persistent chrome), `features/` (one folder per user-facing capability), `registries/` (the registration mechanisms only), `services/`, `store/` (app-wide state), `routing/`, `components/` and `hooks/` (shared UI and hooks), `lib/` (generic non-UI code), `styles/` and `assets/`. Beside it: `src/main/`, `src/preload/`, `src/shared/`, and outside `src/`, `fixtures/` and `tests/`.

- Imports point one way: `shared → lib/styles/assets → routing → components/hooks → store → services → registries → features → layout → app`. Each folder imports only folders before it.
- No feature imports another feature, including its `index.ts`.
- What a feature registers (its panes, screens, commands, keybindings) stays in that feature, in `features/<feature>/contributions/`; `app/` calls each feature's registration.
- `services/` is external communication only.

The rest (what each folder holds, ownership, the inside of a feature, naming, tests, aliases and fixtures) is in [Desktop Structure](../../docs/architecture/desktop-structure.md).

## Chokepoints

- **Figures:** `lib/wire-figures.ts` is the only module that formats a wire value — strings verbatim in mono, quantities through `Intl`, bytes scaled by 1024. Which `Intl` instances are held, and under what cap, is `lib/intl-formatter-cache.ts`.
- **Persistence:** every durable write goes through `store/persistence/` and its closed value-class enumeration, and one byte-measurement function serves every cap. Drafts never reach it.
- **Cost:** every cost figure comes from the committed-spend read; the renderer sums nothing.
- **Refresh:** every refresh goes through `lib/reads/refresh-scheduler.ts`.
- **Readings:** a READING is one class that publishes what a surface reads off it _and_ holds the daemon connection. That same class carries the refresh scheduler and the two `ReadTriggerTarget` members a trigger set wires — `triggeringEventKinds` and `requestRead` — so a reading is always one somebody can ask again. A class that publishes only what an act settled holds neither and is not a reading.
- **Daemon calls:** a surface reaches the daemon through `callDaemon` (`services/daemon/daemon-reply.ts`), which parses the reply against the method's registered schema and answers `served` or `refused`; a surface never parses a wire value itself. A suite that answers one method spreads a real bridge through `tests/helpers/fixture-bridge.ts`'s `withDaemonCall` / `withDaemonSubscribe`, and that namespace spread is written nowhere else — a suite composing its own is a second door.
- **Markup:** `features/transcript/rows/markdown/nodes/MathBlock.tsx` is the renderer's one `dangerouslySetInnerHTML` site, because KaTeX's whole interface is a markup string. Everything else the renderer draws arrives as data; a second occurrence anywhere under `src/renderer/src/` is rejected.
- **Scroll:** `features/transcript/scroll/scroll-chokepoint.ts` is the only module that writes a scroll offset, and every write names its caller so two in one frame can be arbitrated. No `scrollTop` write outside it, and no `scrollIntoView` at all — a glide through the chokepoint replaces it.

## State and views

- Stateful logic is an encapsulated class with private fields. Module-level `let` / `Map` / `Set` singletons are rejected.
- React components are function components that render. Effects, subscriptions, derivations, and store construction live in a class or a hook, never in a render body.
- A closed set is declared once and every consumer derives from it, never a second union with a comment saying it mirrors the first.
- **One store never holds another store's flag.** Window state and session state are two stores on purpose — one per window, one per open session — and a flag copied across that line is a second record of one fact, the one the reconnect path cannot heal. Neither store imports the other (a rule in `.dependency-cruiser.mjs` refuses the edge in both directions, at any depth — it resolves the specifier to a real path, where a `no-restricted-imports` group has to enumerate the relative spellings and stops at the depths that existed when it was written); the registry, the hooks, and the schedulers above them are where the two are composed. No member name is declared by both store states.

## Console design

Neither rule below has a mechanical gate: one reads color values out of stylesheets and the other reads the shape of a sentence, and both answers are judgments a checker gets wrong in the direction that costs the most — a finding about text nobody reads. They are held here, and in review.

- **Two hues carry attention, and a third is never added.** Amber means a person is needed; red means something failed. Every attention color is an `ATTENTION_TOKENS` entry in `styles/palette.ts`, and the brand accent is the one desaturated cyan reserved for interactive affordances. A stylesheet never paints an attention treatment from a hex, a named color, or a raw `oklch()` of its own — that is how a third hue actually arrives, one green tick at a time. A raw `oklch(0% 0 0 / …)` in a `box-shadow` is an opacity rather than a hue and is not this rule's subject.
- **Copy is sentence case, and it neither exclaims nor celebrates.** A receipt states what happened. No exclamation mark, no congratulation, and no Title Case run of three or more words — a heading written as a label reads as a different product beside the twenty calm rows above it.

## Executables

- Every file under `scripts/**` and `build/**` is TypeScript, run under `node --experimental-strip-types`, and typechecked by `tsconfig.scripts.json` or `tsconfig.build.json`. No `.js`, `.mjs`, or `.cjs` executable, and no hand-written `.d.mts`.
- A file that neither `pnpm build` runs nor a package script invokes by name belongs in `src/`.

## Tests

- Co-located `*.test.{ts,tsx}` beside the module, across `src/**`, `build/**`, and `scripts/**`.
- Helper tests live in `tests/helpers/` beside their helpers, in the `main-unit` project. The tiers live under `tests/<tier>/`, one Vitest project each, globs disjoint.
- Shared scaffolding lives once, one home per ROLE, in `tests/helpers/`; a module one tier alone uses sits in that tier's folder. A tier that hand-rolls a role another tier already has is rejected.
- A test never reimplements the rule it checks and never drives a stand-in for the module under test; import the real one. Every clean result has a negative control that fails.
- The screenshot tier is a LOCAL CAPTURE AID, not a gate: `pnpm --filter @ai-sidekicks/desktop run test:screenshot` writes a picture of every surface into the gitignored `tests/screenshot/__screenshots__/`, compares it against nothing, runs in no CI job and in no `pnpm test` chain, and fails only where a surface cannot be captured at all. No image is versioned, and no PR is gated on pixels. Every Vitest run in this package resolves `UPDATE_SNAPSHOT=all` so that a bare `--project=screenshot` run writes exactly as the script does; the same mode is why rule 9 bans the text-snapshot matchers, which under it would rewrite themselves rather than fail.
- A capture is WRITTEN through `tests/screenshot/settled-capture.ts` and no other way. `captureSettled` refuses a tree still carrying the pending marker; a mount never waits for a deferred body itself, and a per-spec wait is rejected.
- Every test that launches Electron goes through `tests/helpers/electron-harness.ts` (Playwright tiers), `tests/helpers/smoke-probe-harness.ts` (smoke), or `tests/helpers/gc-probe-harness.ts` (GC), which set `SIDEKICKS_UNOBTRUSIVE_WINDOWS=1` so a test build never reveals a window, takes focus, or switches Spaces. A `show()` / `showInactive()` / `focus()` call outside `src/main/windows/window-reveal.ts` is rejected.
- A spawned child's lifetime belongs to the test, never to a timer: `tests/helpers/electron-child.ts` registers the kill on `onTestFinished`, and a spawner's own deadline fires before its enclosing per-test budget.
- Before pushing, run `pnpm --filter @ai-sidekicks/desktop run test:changed <base-ref>` plus the files you authored, and `structure`; the aggregate `test` script and the Electron tiers are CI's. That base ref is the first argument of `scripts/test-changed.ts`; no ref, or a file no project claims, exits `2`.

## Config single-sourcing

- One value, one home: budgets and their unit factors in `tests/budget/budgets.json`; each cap lives with its narrowest owner. A threshold restated in a test that also lives in a JSON file is rejected.
- A new Vitest project lands with all five of `vitest.config.ts`, a `test:<project>` script, a Turbo task carrying `inputs`, a line in the aggregate `test` script, and a matrix entry in the `desktop` job of `.github/workflows/ci.yml` — all five or none, a deliberate omission recording its reason beside the registration. `exclude` replaces Vitest's default rather than extending it; spread the default in.
- Each matrix leg of the `desktop` job runs one build flavor, so the tiers that share `out/**` (`build`, `build:smoke`, `build:fixtures`) sit in separate legs; keep them separate when adding a tier.
- A new `tsconfig*.json` reaches `typecheck` in the same commit, and no two configs write to one `outDir`. A `tsconfig` no script and no `references` entry reaches is deleted.

## Budgets

- A budget marked `enforced` is reachable from the aggregate `test` script _and_ from a CI job, and its `measuredBy` names a harness holding the subject it bounds. Unwired, its status is `n/a` naming the wiring task, never `enforced` and unrun.
- Every renderer PR runs every tier whose subject is in-tree; an absent subject is reported `n/a`, never skipped silently.
- Every bounded wait inside a launching tier's body draws on that tier's body allowance through `boundedMs`, so the first wait that cannot fit fails with its own sentence rather than under Vitest's clock. A wait carrying its own literal is rejected.

## Before opening a PR

1. `lint`, `typecheck` and `structure` clean and `test:changed <base-ref>` green, each under `pnpm --filter @ai-sidekicks/desktop run`; `pnpm -w exec eslint .` clean.
2. Every new helper name grepped for a prior implementation — hoist instead of writing the second one.
3. Every file past 900 lines carries a review note saying why it is one concept — the length is a prompt to look for a seam, not a defect to fix by splitting, and a data table and a test suite are never split for size.
4. Every new file sits with its narrowest owner, with no edge against the import direction and no import of another feature; every new constant lives with its narrowest owner, with its rationale.
