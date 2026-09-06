# apps/desktop — structure rules

Binding for every change under `apps/desktop/`, in any tool. Rules only; each one is checkable, by a command or by a grep. Governing docs: `Spec-023 §Console Design (Meridian)`, `Spec-023 §Console Libraries`, `Spec-023 §Console Test Tiers`, Plan-023 Phase 1B and Phase 1C, and the repo-root `.claude/rules/coding-standards.md`. Repo-wide conventions live in the repo-root `AGENTS.md` and `CONTRIBUTING.md`; this file adds only what is specific to this package.

## Mechanical gates

Two commands, two disjoint claims. Both run in CI on every desktop PR, on the tier-1 job, and both fail the PR.

| Command | Catches | Does not catch |
| --- | --- | --- |
| `pnpm --filter @ai-sidekicks/desktop structure:dead-code` (knip) | files, exports, types, and dependencies no entry point reaches | anything about which import is allowed |
| `pnpm --filter @ai-sidekicks/desktop structure:layering` (dependency-cruiser) | import cycles, orphan modules, process-boundary breaks, console DAG violations | anything about reachability |

`pnpm --filter @ai-sidekicks/desktop structure` runs both locally; CI runs them as two Turbo tasks with `--continue`, so one red leg never hides the other's findings. Neither claim subsumes the other: a dead module can be perfectly layered, and a layering violation can sit on a fully reachable path.

Config: `knip.json` (run from the workspace root — a package-scoped run cannot see the pnpm catalog or the root tooling manifest) and `.dependency-cruiser.mjs`. Both refuse a stale config: knip runs with `--treat-config-hints-as-errors`, so a pattern that matches nothing or duplicates a default fails the gate, and with `--treat-tag-hints-as-errors`, so a per-symbol exemption that outlived its consumer fails it too.

The one exemption the dead-code gate admits is per SYMBOL, through knip's `tags` option: `knip.json` sets `"tags": ["-consumedBy"]`, and an export carrying the JSDoc tag `@consumedBy T-023p-1C-<n>` — naming the task, or the comma-separated tasks, that will import it — is excluded. A symbol no task will name is dead code and is deleted, not tagged.

That marker has two halves, and they are deleted together in the PR that imports the symbol. The tag sits where knip reports the finding, which for a barrelled symbol is the BARREL's own export specifier — measured, not assumed: knip reads per-specifier tags on an `export { … } from`, while a tag on the re-exported declaration suppresses nothing there and instead raises an unused-tag hint, because that declaration is referenced by the barrel. The declaration carries the same claim as a one-line `// Consumed by T-023p-1C-<n>` comment, so the symbol names its consumer where a reader meets it. `--treat-tag-hints-as-errors` is what makes the deletion mandatory: the moment a consumer imports the symbol, the surviving tag fails the run.

No other exemption is used. `ignore` and `ignoreIssues` are file-scoped — they exempt every export a file ever grows, not the one symbol that is early — so neither appears here, and no file is exempted. `ignoreDependencies` is not used at all: if a dependency looks unused, it is unused. `ignoreBinaries` carries exactly one entry, `xdpyinfo`, an X11 host utility the Xvfb probe spawns on Linux runners: the CI job's apt step installs it and no manifest could list it. A second entry meets that same standard — a host binary, or nothing.

## Layout — what belongs in each directory

| Directory | Holds | May import |
| --- | --- | --- |
| `src/main/` | Electron main process: window, protocol, menu, supervision | `electron`, `node:*`, `@ai-sidekicks/contracts`, `src/shared/` |
| `src/preload/` | `contextBridge.exposeInMainWorld` only — no logic, no branching | `electron`, `@ai-sidekicks/contracts` |
| `src/shared/` | Types and pure functions two or more of main / preload / renderer need | `@ai-sidekicks/contracts` and nothing else |
| `src/renderer/src/console/` | The Meridian console | `src/shared/`, contracts, the adopted libraries |
| `src/renderer/src/<family>/` | Another plan's renderer subtree | same as `console/`; the console imports these through no path |
| `build/` | Executables run _during_ `pnpm build` | `node:*`, `src/shared/` |
| `scripts/` | Executables invoked _by name_ from a package script | `node:*`, `src/shared/` |
| `test/` | Cross-process suites and the console tiers under `test/console/<tier>/` | anything |

There is exactly one shared layer. `src/renderer/src/shared/` is not created; a renderer-wide helper lives in the lowest console family that needs it, and a cross-process one in `src/shared/`. First residents of `src/shared/`: `auxiliary-routes.ts` and `wire-errors.ts`.

## Import boundaries

- Renderer source never imports `electron`, `electron/*`, `node:*`, bare Node builtins, `@ai-sidekicks/runtime-daemon`, `@ai-sidekicks/control-plane`, or any path under `main/` or `preload/`. Declared in `eslint.config.mjs`; add a new ban there, never in a test.
- Main and preload never import from `src/renderer/`. A value both sides need goes in `src/shared/` and is imported by both — never mirrored by hand.
- The console families form a DAG, low to high: `core → tokens → routing → primitives → store / persistence → bridge → seats → palette → frame → view families`. A family imports any family below it and none above it. An upward edge fails `structure:layering`; hoist the symbol down to the lowest family that needs it, never deep-import around it.
  - `core/` holds `constants.ts`, `tripwires.ts`, `keyed-registry.ts`, `refusal.ts`, `emitter.ts`, `clock.ts`, `fixture-globals.ts`.
  - `routing/` holds `ConsoleRoute`, `parseRoute`, `formatRoute`, `railDestinationFor`.
  - Chord formatting lives in `primitives/chord-format.ts`; the palette consumes it.
  - `seats/` holds the contracts through which view families hand each other bodies — the pane registry with its kinds and addresses, the pane chrome every pane wears, the composer seat, sidebar sections, the timeline row slot, the inline-card seats. Nothing there holds a BODY: the chrome is the one component, it renders a frame around `children` the owning family supplies, and it is here because the deck that provides its host controls is itself a view family. It sits directly above `bridge/` because that is the highest family a seat imports, and below `palette/` and `frame/` because the frame composes the pane-registry singleton.
  - A VIEW family is any console directory that is none of the layer families above and neither of the two composition sites (`families.ts`, and the files directly under `panes/`). The layering gate states that as the complement rather than as a list, so a family added by a branch is covered the moment its directory exists — no ladder to remember, and no silent hole when one is forgotten. `workspace/`, `ledger/`, `collaboration/`, `repos/`, `workflows/`, `browser/`, `terminal/`, and their siblings are view families. `panes/` is FLAT — it holds composition only, one reserved line per family, and a module under `panes/<something>/` fails `structure:layering` under `console-panes-hold-no-body`: a pane body lives in `<family>/pane/`, where the sibling-isolation rule can see it.
  - View families are SIBLINGS, not a ladder: one view family never imports another. `collaboration/` → `repos/` fails `structure:layering` under `console-view-family-isolation` exactly as an upward edge does — hoist the shared contract into `seats/`, or into the lowest layer family that needs it. Only the two composition sites name more than one view family.
- Console code reaches the bridge only through `console/bridge/BridgeProvider.tsx`; `window.sidekicks` appears in no other renderer file.
- The console imports no plan-owned renderer subtree whose owner mounts into it — `timeline/`, `usage-meters/`, `run-controls/`, `provider-accounts/`, `sidekick-definitions/`, `mcp-governance/`. Those reach the frame by calling `registerConsoleSurface`, which is a call and not an import, so the rule takes no exception; a later mounted page joins the list in `.dependency-cruiser.mjs`. The three shipped Tier-1 components — `session-bootstrap/`, `session-members/`, `runtime-node-attach/` — are absorbed by import and are not on it.
- The console never re-authors or moves a body another plan owns.

## Shared code

- A helper used by two modules is hoisted on the second use. Never write it twice; never write "LOCAL DUPLICATE" in a comment. Homes: cross-process → `src/shared/`; cross-family → the lowest family in the DAG; cross-test → `test/helpers/` and `test/console/`.
- One implementation per job. Before adding a formatter, parser, walker, argument parser, registry, clock, adapter, scheduler, or refusal constructor, grep the tree — then check the `node:` standard library.
- Two sides of one seam (producer and consumer, encoder and decoder) share a module. Never two copies of one regular expression or normalization: they drift, and the gate goes green.

## Chokepoints

- **Figures:** `console/primitives/wire-figures.ts` is the only module that formats a wire value — strings verbatim in mono, quantities through `Intl`, bytes scaled by 1024 there and nowhere else.
- **Persistence:** every durable write goes through `console/persistence/` and its closed value-class enumeration; one byte-measurement function serves every cap. Drafts never reach it.
- **Cost:** every cost figure comes from the committed-spend read; the renderer sums nothing.
- **Refresh:** every refresh goes through `console/store/scheduling.ts`. No `setInterval`.

## Module shape

- Named exports only. `export default` is for tool configuration at the package root only — `*.config.{ts,mjs}` and `.dependency-cruiser.mjs`, which their tools load by default export.
- Every console family carries exactly one `index.ts` — its family door. Cross-family imports go through it; intra-family imports are deep. A barrel re-exports only its own family — no re-export chains, enforced by `console-no-barrel-chain` in `.dependency-cruiser.mjs`: an `index.ts` under `console/` that carries an `export … from` reaching another `index.ts` under `console/` fails `structure:layering`.
  - A door line exists for a production reader, and `test/console/architecture/barrel-census.test.ts` fails one that has none — the class the dead-code gate cannot report, since a co-located test is a Vitest entry and a barrel line reached from one is reachable. Two dispositions: name the task that will import it (`@consumedBy T-023p-1C-<n>` where knip needs its exemption, the `// Consumed by T-023p-1C-<n>` line where it does not — a tag knip does not need fails the run — retired by the PR that imports the symbol through the door), or delete the line, its tests then reading the module that declares the symbol.
  - A sub-module directory inside a family (`bridge/growth-values/`, `bridge/scenarios/`) may carry its own `index.ts`. That is a sub-module door, not a second family door: it publishes to its own family only, it is reached by deep intra-family specifiers, and the family door re-exports a symbol from the module that DECLARES it, never through the inner barrel. A sub-module door that would be reached from outside its family is not a sub-module — promote the directory to a family and give it a place on the DAG.
  - A sub-module door publishes what a SIBLING takes, and a name whose only reader is outside the family is deliberately absent from it: an inner barrel line no sibling reaches is a dead export the barrel census fails, so a door is never widened for symmetry.
  - A sub-module directory whose modules NO sibling takes from carries no `index.ts` at all. Nothing requires one — the family door must re-export from the declaring module regardless, so a door written for symmetry would publish names only that door's own family door could reach, and it cannot reach them. Each such directory folds one wire for the family door and for nobody else. **Read the tree rather than a list here**, for `§Tests`' reason: a roster of instances written into this sentence was three names over a tree holding four, and the fourth was a directory two siblings deep-imported — so it needed a door under this very rule and the sentence read as though it were covered by the exemption. What is enforced is the CONDITION and not the roster: no sibling reader means no door, and one sibling reader means a door publishing what that sibling takes.
  - A `.test-support` module outside `console/` reaches a console module DIRECTLY, and the door rule subtracts it on the source side. Both remedies that rule offers are closed to it: a door cannot publish a fixture helper, because `barrel-census` fails a specifier no production module reads, and a helper has no home below the family whose fixture it drives. Production modules outside the console are still held to the door, which is the claim that rule was written to make.
  - A door is an edge to every module it re-exports from, so a sibling reads one only where the whole door is acyclic from where it stands. Inside a tightly coupled family that is often false — reaching `bridge/scenario-runtime/index.js` from `bridge/console-bridge.ts` would drag the scenario manifest, which reaches the fixture, which imports the bridge contract, and `no-circular` fails it. The remedy is the deep specifier for that one edge, never a shim and never a wider door; `bridge/fixture/fixture-refusal.ts` is the same remedy applied by splitting instead.
- A stylesheet enters through the barrel of the directory that OWNS it, and through no component. A directory owns its own sub-directories that carry no `index.ts` of their own, so a family door pulling in those sheets is the family importing its own rules and is the intended shape rather than an exception to it — the owner is what the rule keys on, not the depth. A directory that carries a door — another family, a sub-module door, a lazily-loaded chunk — has an owner of its own, and reaching into one is the shape this forbids: it puts that surface's rules on the initial document for every session that never opens it, and it makes one directory the reason another is styled at all.
- `.tsx` files are PascalCase, one component each — `.test-support.tsx` scaffolding included, since a shared harness is a module like any other; a co-located `.test.tsx` may declare the private probe components its own cases need; `.ts` modules are kebab-case, named for the noun they own (`-store`, `-registry`, `-adapter`), matching `packages/runtime-daemon/src/`.
- A file over about 400 lines is doing two jobs. Split it before pushing.
- Full descriptive identifiers per `.claude/rules/coding-standards.md`; single- and few-letter names only for loop indices, `catch` bindings, and coordinates. `ix`, `cmd`, `args`, `a`/`b`, `el` are rejected.

## State and views

- Stateful logic is an encapsulated class with private fields. Module-level `let` / `Map` / `Set` singletons are rejected.
- React components are function components that render. Effects, subscriptions, derivations, and every store construction live in a class or a hook — never in a render body.
- A closed set is declared once and every consumer derives from it — never a second union with a comment saying it mirrors the first.

## Executables

- Every file under `scripts/**` and `build/**` is TypeScript (`.ts` or `.mts`), run under `node --experimental-strip-types`, and typechecked by `tsconfig.scripts.json` or `tsconfig.build.json`, both of which the `typecheck` script reaches. No `.js`, `.mjs`, or `.cjs` executable, and no hand-written `.d.mts` beside one: a declaration nothing checks against its implementation is a claim, not a type.
- `build/` runs during `pnpm build`. `scripts/` is invoked by name from a package script. A file in neither position belongs in `src/`.

## Tests

- Co-located `*.test.{ts,tsx}` beside the module for `console/`, `src/renderer/src/shell/` (a `console-unit` resident, since it composes console seats), and `src/main/**`. No new `__tests__/`; the three legacy renderer families keep theirs and are not converted.
- The console tiers live under `test/console/<tier>/`, one Vitest project each, globs disjoint.
- Shared scaffolding lives once, and one home per ROLE. Cross-process roles go in `test/helpers/` — the `vi.mock("electron")` factory in `test/helpers/electron-mock.ts`, and any second one is rejected. Console roles are the flat files of `test/console/`, beside the tier directories: the render and launch harnesses, the launch budgets and their deadline, the source and config readers the architecture tier parses through, the built-asset readers, and the cleanup disciplines. **Read the directory rather than a list here** — a closed set was written into this sentence once and was four names over a directory holding sixteen, because a list in prose is a claim that goes stale the next time a tier needs a role and nothing reports it. What is enforced is the role, not the roster: a tier that hand-rolls a role another tier already has is rejected, and a second file for a role that has one is rejected with it.
- A test never reimplements the rule it checks and never drives a local stand-in for the module under test; import the real one. Every clean result has a negative control that fails.
- Every test that launches Electron goes through `test/console/electron-harness.ts` (Playwright tiers) or `test/helpers/electron-probe.ts` (the smoke and GC probes), which set `SIDEKICKS_UNOBTRUSIVE_WINDOWS=1` so a test build never reveals a window, takes focus, or switches the operator's Space, with background throttling off and the harness witnessing the visibility state and two animation frames on every launch (`src/main/window-reveal.ts`). A test that spawns Electron any other way, and a `show()` / `showInactive()` / `focus()` call outside `window-reveal.ts`, is rejected.

## Config single-sourcing

- One value, one home: budgets and their unit factors in `budgets.json`, caps in `console/core/constants.ts` with a rationale each. A threshold restated in a test that also lives in a JSON file is rejected.
- A new Vitest project lands with all five of `vitest.config.ts`, a `test:<project>` script, a Turbo task carrying `inputs`, a line in the aggregate `test` script, and a line in the desktop step of `.github/workflows/ci.yml` — all five or none. `test/console/architecture/ci-tier-coverage.test.ts` enforces the last two by resolving the real project set and reading both files, so a project wired into neither is a red check rather than a silent gap. A project the aggregate deliberately omits records its reason in that test's exemption map — the two entries today are `console-screenshot`, whose references are committed per platform and which runs in its own pinned `console-screenshot-macos` job, and `console-bench`, which records timings and gates nothing. `exclude` replaces Vitest's default rather than extending it; spread the default in.
- The aggregate `test` script and the CI desktop step run the tiers in the same order, and that order is load-bearing: `build`, `build:smoke`, and `build:fixtures` all write `out/**`, so a tier runs against the flavour its own Turbo edge produced and before the next flavour overwrites it. A group added in one place is added in the other.
- A new `tsconfig*.json` reaches the `typecheck` script in the same commit, and no two configs write to one `outDir`. A `tsconfig` that no script and no `references` entry reaches is deleted.

## Budgets and tripwires

- A budget marked `enforced` is reachable from the aggregate `test` script _and_ from a CI job, and its `measuredBy` names a harness that holds the subject it bounds. If it is not wired, its status is `n/a` naming the wiring task — never `enforced` and unrun. The two `enforced` rows today are `renderer-initial-bundle`, reached through the `console-bundle` tier, and `renderer-heap-at-rest`, reached through the `console-endurance` tier; both tiers are on both.
- Every console PR runs every tier whose subject is in-tree; an absent subject is reported `n/a`, never silently skipped. Every tripwire asserts it matched at least one site; zero matches fails.

## Pre-PR self-audit

1. `pnpm --filter @ai-sidekicks/desktop lint typecheck test structure` clean; `pnpm -w exec eslint .` clean.
2. Grep the tree for each new helper name — is it the second implementation? Hoist instead.
3. Every new symbol reachable from an entry point, or named by the surface registry or the growth slate.
4. Every new family: one `index.ts`; cross-family imports through barrels; no edge against the DAG.
5. No `window.sidekicks` outside `bridge/BridgeProvider.tsx`; no `setInterval`; no second byte formatter, argument parser, or directory walker; no `export default` outside root tool configuration; no module-level `let`; no second `vi.mock("electron")` factory; no `TODO` claiming a module absent that now exists.
6. Every closed set declared once; every new constant in `core/constants.ts` with its rationale.
7. New Vitest project → config + `test:<project>` script + Turbo task + aggregate `test` script + CI desktop step; its glob disjoint from every other, and every test file matched by exactly one project.
8. Budgets and tiers actually ran; no file over about 400 lines; no identifier against the naming rule; every temporary directory removed in `afterEach`.
