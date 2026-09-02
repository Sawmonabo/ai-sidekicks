# apps/desktop — structure rules

Binding for every change under `apps/desktop/`, in any tool. Rules only; each one is checkable, by a command or by a grep. Governing docs: `Spec-023 §Console Design (Meridian)`, `Spec-023 §Console Libraries`, `Spec-023 §Console Test Tiers`, Plan-023 Phase 1B and Phase 1C, and the repo-root `.claude/rules/coding-standards.md`. Repo-wide conventions live in the repo-root `AGENTS.md` and `CONTRIBUTING.md`; this file adds only what is specific to this package.

## Mechanical gates

Two commands, two disjoint claims. Both run in CI on every desktop PR, on the tier-1 job, and both fail the PR.

| Command | Catches | Does not catch |
| --- | --- | --- |
| `pnpm --filter @ai-sidekicks/desktop structure:dead-code` (knip) | files, exports, types, and dependencies no entry point reaches | anything about which import is allowed |
| `pnpm --filter @ai-sidekicks/desktop structure:layering` (dependency-cruiser) | import cycles, orphan modules, process-boundary breaks, console DAG violations | anything about reachability |

`pnpm --filter @ai-sidekicks/desktop structure` runs both locally; CI runs them as two Turbo tasks with `--continue`, so one red leg never hides the other's findings. Neither claim subsumes the other: a dead module can be perfectly layered, and a layering violation can sit on a fully reachable path.

Config: `knip.json` (run from the workspace root — a package-scoped run cannot see the pnpm catalog or the root tooling manifest) and `.dependency-cruiser.mjs`. Both refuse a stale config: knip runs with `--treat-config-hints-as-errors`, so a pattern that matches nothing or duplicates a default fails the gate.

A knip `ignore` entry is allowed for exactly one thing: a symbol that carries the comment `// Consumed by T-023p-1C-<n>` naming the task that will import it. Nothing else in this tree gets an ignore entry. `ignoreBinaries` and `ignoreDependencies` are not that lever and are not used; if a dependency looks unused, it is unused.

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
- The console families form a DAG, low to high: `core → tokens → routing → primitives → store / persistence → bridge → palette → frame → view families`. A family imports any family below it and none above it. An upward edge fails `structure:layering`; hoist the symbol down to the lowest family that needs it, never deep-import around it.
  - `core/` holds `constants.ts`, `tripwires.ts`, `keyed-registry.ts`, `refusal.ts`, `emitter.ts`, `clock.ts`, `fixture-globals.ts`.
  - `routing/` holds `ConsoleRoute`, `parseRoute`, `formatRoute`, `railDestinationFor`.
  - Chord formatting lives in `primitives/chord-format.ts`; the palette consumes it.
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
- Every console family carries exactly one `index.ts`. Cross-family imports go through it; intra-family imports are deep. A barrel re-exports only its own family — no re-export chains.
- A family's CSS is imported from that family's barrel and from nowhere else.
- `.tsx` files are PascalCase, one component each; `.ts` modules are kebab-case, named for the noun they own (`-store`, `-registry`, `-adapter`), matching `packages/runtime-daemon/src/`.
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

- Co-located `*.test.{ts,tsx}` beside the module for `console/` and `src/main/**`. No new `__tests__/`; the three legacy renderer families keep theirs and are not converted.
- The console tiers live under `test/console/<tier>/`, one Vitest project each, globs disjoint.
- Shared scaffolding lives once, and one home per role. Cross-process roles go in `test/helpers/` — the `vi.mock("electron")` factory in `test/helpers/electron-mock.ts`, and any second one is rejected. Console roles go in `test/console/`: `console-harness.tsx` (render harness) and `electron-harness.ts` (spawn-and-scan) are the residents; a temp-directory helper, a script runner, and a path resolver take `temp-dir.ts`, `run-script.ts`, and `paths.ts` there when first needed. A tier that hand-rolls a role another tier already has is rejected.
- A test never reimplements the rule it checks and never drives a local stand-in for the module under test; import the real one. Every clean result has a negative control that fails.

## Config single-sourcing

- One value, one home: budgets and their unit factors in `budgets.json`, caps in `console/core/constants.ts` with a rationale each. A threshold restated in a test that also lives in a JSON file is rejected.
- A new Vitest project lands with all four of `vitest.config.ts`, a `test:<project>` script, a Turbo task carrying `inputs`, and a line in the aggregate `test` script — all four or none. `exclude` replaces Vitest's default rather than extending it; spread the default in.
- A new `tsconfig*.json` reaches the `typecheck` script in the same commit, and no two configs write to one `outDir`. A `tsconfig` that no script and no `references` entry reaches is deleted.

## Budgets and tripwires

- A budget marked `enforced` is reachable from the aggregate `test` script _and_ from a CI job. If it is not wired, its status is `n/a` naming the wiring task — never `enforced` and unrun.
- Every console PR runs every tier whose subject is in-tree; an absent subject is reported `n/a`, never silently skipped. Every tripwire asserts it matched at least one site; zero matches fails.

## Pre-PR self-audit

1. `pnpm --filter @ai-sidekicks/desktop lint typecheck test structure` clean; `pnpm -w exec eslint .` clean.
2. Grep the tree for each new helper name — is it the second implementation? Hoist instead.
3. Every new symbol reachable from an entry point, or named by the surface registry or the growth slate.
4. Every new family: one `index.ts`; cross-family imports through barrels; no edge against the DAG.
5. No `window.sidekicks` outside `bridge/BridgeProvider.tsx`; no `setInterval`; no second byte formatter, argument parser, or directory walker; no `export default` outside root tool configuration; no module-level `let`; no second `vi.mock("electron")` factory; no `TODO` claiming a module absent that now exists.
6. Every closed set declared once; every new constant in `core/constants.ts` with its rationale.
7. New Vitest project → config + `test:<project>` script + Turbo task + aggregate `test` script; its glob disjoint from every other, and every test file matched by exactly one project.
8. Budgets and tiers actually ran; no file over about 400 lines; no identifier against the naming rule; every temporary directory removed in `afterEach`.
