# apps/desktop — structure rules

Binding for every change under `apps/desktop/`, on top of the root `AGENTS.md`. Paths are relative to `apps/desktop/` or the renderer root `src/renderer/src/`. Read [Desktop Structure](../../docs/architecture/desktop-structure.md) before adding a folder, moving a file, or adding or changing a lint or layering rule: it lists what each folder and feature holds and each check's exact scope. What each process does is in [Desktop Architecture](../../docs/architecture/desktop.md).

## Launching

`pnpm --filter @ai-sidekicks/desktop dev` runs the app on the renderer's dev server. After `--`, `--fixture <scenario>` plays a scenario from `fixtures/index.ts` and `--session <session-id>` opens one of its sessions; `src/main/fixture-launch.ts` checks both against the catalog. An unknown scenario, a missing value or a session the scenario lacks stops the launch before any window opens, with no fallback. Only the development build and `build:fixtures` carry scenarios; every other build refuses `--fixture`.

## Before pushing

Run `test:changed <base-ref>` plus the files you authored, and `structure`. Before opening a PR, also run `lint` and `typecheck`, all under `pnpm --filter @ai-sidekicks/desktop run`, then `pnpm -w exec eslint .`; every one clean. `test:changed` exits `2` with no ref or a file no project claims. The aggregate `test` script and the Electron tiers are CI's.

## Layout

The renderer root `src/renderer/src/` is never flattened into `src/renderer/`. It holds `main.tsx`, `desktop-bridge.d.ts`, the environment declarations and these folders only:

- `app/` — composition and bootstrap only; `app/hooks/` holds only the window's composition and bootstrap hooks, and a reusable hook goes to `hooks/`.
- `layout/` — persistent chrome only. `features/` — one folder per user-facing capability.
- `registries/` — the generic registration mechanisms only (`registerX`, `getX`, their types and read hooks); no `index.ts`, importers use the declaring modules.
- `services/` — external communication only, each client with its fixture implementation beside it. `store/` — app-wide projections and state only.
- `routing/` — route addresses and parsing. `components/` — shared UI, one PascalCase folder per component with its tests and CSS. `hooks/` — shared hooks. `lib/` — generic non-UI code. `styles/` — design tokens and global sheets. `assets/` — only `assets/icons/signature/`, the icon SVGs.

- **A feature** is a cohesive user-facing capability or workflow; a domain object alone never makes one, and a backend noun never makes a renderer folder. A new top-level folder needs a concrete ownership or dependency need.
- **Feature limits:** `sessions/` owns the Sessions destination whole (the list and the session screen); `settings/` holds the settings pages only; `repos/` owns git and source control; `workflows/param-form/` is used only by workflows.
- **Inside a feature** a folder is added only when needed: top views at the root, then `components/`, `hooks/`, `services/`, `contributions/`, `types.ts`, `index.ts`, and non-UI modules named for what they hold. A large feature has one sub-folder per distinct responsibility, shaped the same inside.
- **A feature's `index.ts`** is its public entry: the one module another folder imports from the feature.
- **Inside every layer, feature and `tests/`, modules are grouped by topic in folders, never by a shared file-name prefix,** under the same rules as [`packages/AGENTS.md` §Folders by topic](../../packages/AGENTS.md#folders-by-topic): three `launch-*.ts` helpers beside each other mean a `launch/` folder is missing, and a name inside one drops every word a folder above it says (`viewport/anchor-capture.ts`, not `viewport/viewport-anchor-capture.ts`), except a component's or hook's file, which keeps its exact name.
- **A `services/` client is named for the contract it speaks** (`services/provider-accounts/`, an artifacts client in `services/artifacts/`), never for the feature that calls it; a call one feature alone makes stays in that feature's `services/`.
- **A hook** lives in `useThing.ts` under its owner's `hooks/`. A file mixing hooks with other code is split when the other code is used without the hook.
- **Main.** `src/main/` keeps `index.ts`, `menu.ts` and `fixture-launch.ts` at its root and groups the rest into `windows/` (the one window factory and main's registry of windows), `bridge/` (main's handler for each preload bridge method), `appearance/` (the kept appearance record and the platform scheme it drives), `services/` and `probes/`; a further folder is made when its first file lands.
- **Package files outside `src/`.** `build/` holds the build's own TypeScript and tests and the packaging inputs: the app icon `build/icon.icon`, an Icon Composer document (the neon robot with a voice-waveform mouth), and its glow layer's source `build/icon-glow.svg`. `resources/` holds the files main loads at run time: the menu-bar icon `resources/trayTemplate.png` and `@2x`, a one-color template of the app icon drawn from `resources/tray.svg`.
- **Preload and shared.** `src/preload/index.ts` is the expose call alone; the exposed type is `PreloadApi` in `src/shared/`, so the preload has no `types.ts`. `src/shared/` holds desktop-only contracts as flat files; a subfolder is made when the second file of its kind lands, never ahead, and none is forbidden: the narrowest owner decides.
- **Contracts live by boundary** (root rule 9 says what goes to `packages/contracts`). A front-end type lives in the renderer; a type one module uses stays beside it.

## Ownership

Every file lives with its narrowest owner, proven by its importers: a file one feature imports lives in that feature; a shared folder holds only what two or more owners import.

- **Contributions stay with their feature,** in `features/<feature>/contributions/` (one file per registry when substantial); `app/registrations.ts` calls each feature's registration and holds no table or lookup.
- **Nothing goes to `services/` because it imports the bridge, the store or `lib/`.** Domain reads, selectors, projections, identities and view models go to their owning feature, `store/` or `lib/`.
- **No feature imports another,** nor its `index.ts`. What two features share goes through `registries/` or down to `components/`, `hooks/`, `store/` or `lib/`. The session screen composes other features' panes through `app/` and the pane, contribution and registry seams.
- **A list several features read is app-wide state** (agent definitions, skills): `services/daemon/` keeps it current in `store/`, and no feature exports a list another draws. A control two features draw alike is one component in `components/`, its non-UI logic in `lib/`.
- **Attention is app-wide:** projection, count and notifier in `store/attention/`, mounted by `app/`; presentation in `layout/NotificationsList/`.
- **Every new constant lives with its narrowest owner, with its rationale.** A protocol or cross-boundary value goes to its contract or shared owner, a feature's limit to that feature, an app-wide implementation limit to the shared module that uses it.
- **An overlay goes by ownership:** one feature's wrapper lives in it; one reused by unrelated features stays in `components/`.

## Imports

- **The direction:** `shared → lib/styles/assets → routing → components/hooks → store → services → registries → features → layout → app`. Each folder imports only folders before it; `services/` may import the store's types.
- **Package imports** (`#renderer/*`, `#main/*`, `#preload/*`, `#shared/*`, `#fixtures/*`, `#test/*`, `#scripts/*`) are defined once, in `package.json` `"imports"`, which Node, TypeScript, Vite, Vitest, knip and dependency-cruiser all read. An import across top-level folders uses one; one inside a feature or module stays `./`. No file in the package imports through three or more `../` (gate 14 checks the renderer). A file a tool loads itself (`vitest.config.ts`, `electron.vite.config.ts` and every module they import, and everything under `build/` and `scripts/`) may use them too, naming the real file with its extension (`#scripts/budget/budget-registry.mts`), since Node maps no `.js` specifier to a `.ts` source.
- **The process boundary.** The renderer requests, main owns the native windows, the daemon owns the work. The renderer holds no Electron, Node or filesystem authority; it reaches the `window.*` and `preview.*` contracts only through its `services/` clients, and gets `PlatformBridge`, which every host implements, from `PlatformBridgeProvider` (`usePlatformBridge`).
- **Renderer import bans.** Renderer code never imports `main/` or `preload/`, relatively or through `#main` / `#preload`, nor Electron, a Node builtin, or the daemon or control-plane package. `src/shared/**` may import the contracts package and nothing else (`shared-imports-nothing`): no Electron, Node builtin, React, daemon or control-plane package. Main and preload never import renderer code; a value both sides need lives in `src/shared/`.
- **Wire values are parsed in `services/`.** Elsewhere, renderer code imports neither `zod` nor a contracts schema (an export ending in `Schema`); a test may parse through a contracts schema to build or check contract-shaped data. A module that validates data it owns rather than a wire value may use `zod` once named in `eslint.config.mjs`, and still imports no contracts schema. The one named module, the approval fold `store/session-events/approval-flow-projection.ts`, reads approval payloads through their contracts schemas and imports no `zod`, until the approval card's build moves that read into `services/` and the allowance with it.

## Fixtures

Fixtures conform to production boundaries and never define them.

- `fixtures/` holds scenario definitions and scripted data only, and never ships: a release build carries no fixture code and no catalog.
- A fixture implementation sits beside the real owner it substitutes. A feature has a `fixtures/` folder only when it owns the replaced boundary. Code that ships never sits in any `fixtures/` folder, even when it is a default a fixture can replace. `app/fixture/composition.ts` chooses fixture implementations once, at startup; no `if (fixture)` anywhere else.
- No `demo/`, fake backend layer or generic fixture method catalog. Fixture-only types stay in `apps/desktop`. Code says `fixture` and `scenario`, never `demo`; a scenario is named for the stable behavior it exercises, never an incidental count or sample content.
- `fixtures/` imports `src/` only as types. Only fixture implementations, `app/fixture/composition.ts`, `app/pane-harness/`, `tests/` and `src/main/fixture-launch.ts` import `fixtures/`.

## Chokepoints

- **Figures:** only `lib/wire/figures.ts` formats a wire value: strings verbatim in mono, quantities through `Intl`, bytes scaled by 1024. `lib/intl-formatter-cache.ts` holds the `Intl` instances and their cap.
- **Persistence:** every durable write goes through `store/persistence/` and its closed value-class enumeration; one byte-measurement function serves every cap. Drafts never reach it.
- **Cost:** every cost figure comes from the committed-spend read; the renderer sums nothing.
- **Refresh:** every refresh goes through `lib/reads/refresh/refresh-scheduler.ts`.
- **Time:** renderer code never calls `Date.parse` or `new Date(<string>)` and never orders time stamps as text.
- **Readings:** a reading is one class that publishes what a surface reads _and_ holds the daemon connection, the refresh scheduler and the `ReadTriggerTarget` members `triggeringEventKinds` and `requestRead`, so it can always be asked again. A class publishing only what an act settled holds none of them and is not a reading.
- **Daemon calls:** a surface reaches the daemon through `callDaemon` (`services/daemon/daemon-reply.ts`), which parses the reply against the method's schema and answers `served` or `refused`. A suite answering one method spreads a real bridge through `withDaemonCall` / `withDaemonSubscribe` in `tests/helpers/fixture/bridge.ts`, never its own.
- **Markup:** `components/Markdown/MathBlock.tsx` is the one `dangerouslySetInnerHTML` site (KaTeX's interface is a markup string); a second is rejected.
- **Scroll:** only `lib/scroll/chokepoint.ts` writes a scroll offset, and every write names its caller. No `scrollTop` write elsewhere and no `scrollIntoView`: glide through the chokepoint.

## State and views

- Stateful logic is an encapsulated class with private fields. A module-level `let`, `Map` or `Set` singleton and an exported collection are rejected in every desktop file; gate 4 lints the `let` in shipped renderer source, and review catches it everywhere else.
- React components are function components that render. Effects, subscriptions, derivations and store construction live in a class or a hook, never a render body.
- **One store never holds another store's flag.** The window store (one per window) and the session store (one per open session) never import each other and share no member name; the registry, hooks and schedulers above them compose the two.

## App design

Held in review; a checker would get both wrong.

- **Two hues carry attention, never a third:** amber, a person is needed; red, something failed. Every attention color is an `ATTENTION_TOKENS` entry in `styles/palette.ts`; the brand accent is one desaturated cyan, for interactive affordances and a running state. No stylesheet paints an attention treatment from its own hex, named color or raw `oklch()`; a raw `oklch(0% 0 0 / …)` in a `box-shadow` is an opacity, not a hue.
- **Copy is sentence case, never exclaims or celebrates.** A receipt states what happened: no exclamation mark, no congratulation, no Title Case run of three or more words.

## Naming

- **Screens.** A destination's view is a screen (`Screen<Id, Params>`, `SessionScreen`, `AgentsScreen`), and "screen" names nothing else. `ScreenView` is only the frame region showing the screen the rail picked. Routing stays in `app/AppRouter.tsx`. A session's arrangement of panes is its pane layout, never "screen view" or "deck".
- **"Workspace"** means only the managed folder on disk a session is bound to; there is no `features/workspace/`.
- **`transcript` and `preview`** name the transcript and the Preview pane; a name about the real browser the pane drives keeps "browser".
- **Keybindings** are `Keybinding`, `keybinding`, `keybindings` in identifiers.
- **`shared`** means code both Electron processes use.

## Styling

Plain CSS on global design tokens in `styles/`. No `*.module.css`.

- A component imports its own sheet, beside it (`ChordHint.tsx` imports `./ChordHint.css`); no `index.ts` exists only to load a sheet.
- A sheet styling several components of one feature stays whole, imported by the feature's top view or its lazily-loaded chunk root (`*-body.{ts,tsx}`).
- A global sheet (a utility class, or a treatment shared components compose) lives in `styles/`, imported by `main.tsx`.
- No file imports another folder's sheet, except a chunk root and `main.tsx`.
- A CSS class has one owning stylesheet; two sheets declaring it at equal specificity resolve by load order.
- A treatment several features share is one class in a `styles/` sheet, applied beside the control's own class (the action button and disclosure trigger in `styles/action-buttons.css`). The control's class keeps only layout, state and variation; a class left with no rules is removed.
- A shared component owns every rule for its classes. A feature varies it through its modifier, `data-*` attribute or custom property, never by restyling the class from another sheet.
- A feature-private class carries the feature's name as its prefix when it is new or is already being renamed with the concept it names. Renaming a class or token follows the root rename rule.
- A custom property a component reads and a caller may set has a fallback (`var(--figure-wire-color, inherit)`); without one the declaration drops silently.

## Tests

- A test sits beside its subject as `*.test.ts(x)`, across `src/**`, `build/**` and `scripts/**`; the desktop has no `__tests__/`. Playwright runs inside Vitest as the Electron driver.
- `tests/` holds only tests spanning modules or the app: `helpers/` and the tiers `browser/`, `e2e/`, `endurance/`, `accessibility/`, `budget/`, one Vitest project each, globs disjoint. A test reading one scenario's data sits beside that scenario.
- Shared scaffolding lives once per role in `tests/helpers/`; a module one tier alone uses sits in that tier's folder; a tier hand-rolling a role another has is rejected. Helper tests sit beside their helpers in `main-unit`, except those needing the renderer's DOM: `RENDERER_TESTS_OUTSIDE_SOURCE` in `vitest/tier-projects.ts` moves them, and the scenario contract check's suite, to `renderer`.
- A test never reimplements the rule it checks or drives a stand-in for the module under test. Every clean result has a negative control that fails.
- A test launching Electron goes through `tests/helpers/electron/harness.ts`, `tests/helpers/smoke-probe/harness.ts` or `tests/lifecycle.gc.test-support.ts` (they set `SIDEKICKS_UNOBTRUSIVE_WINDOWS=1`). No `show()`, `showInactive()` or `focus()` outside `src/main/windows/reveal.ts`.
- A spawned child's lifetime belongs to the test (gate 5's module kills it on `onTestFinished`), and a spawner's deadline fires before its per-test budget.

## Executables and config

- Every file under `scripts/**` and `build/**` is TypeScript, run with `node --experimental-strip-types`, typechecked by `tsconfig.scripts.json` or `tsconfig.build.json`. No `.js`, `.mjs` or `.cjs` executable, no hand-written `.d.mts`. A file neither `pnpm build` runs nor a package script names belongs in `src/`.
- Budgets and their unit factors live in `tests/budget/budgets.json`; a test never restates a threshold.
- A new Vitest project lands with all five of `vitest.config.ts`, a `test:<project>` script, a Turbo task with `inputs`, a line in the aggregate `test` script, and a matrix entry in the `desktop` job of `.github/workflows/ci.yml` (`desktop-slow` for a nightly and `main`-only tier); a deliberate omission records its reason beside the registration. `exclude` spreads Vitest's default in.
- Tiers sharing `out/**` (`build`, `build:smoke`, `build:fixtures`) sit in separate matrix legs.
- A new `tsconfig*.json` reaches `typecheck` in the same commit; no two configs share an `outDir`; a `tsconfig` nothing reaches is deleted.
- A budget marked `enforced` is reachable from the aggregate `test` script and a CI job, its `measuredBy` naming a harness holding its subject; otherwise it is `n/a` naming the wiring task. Every renderer PR runs every tier whose subject is in-tree and reports an absent one `n/a`.
- Every bounded wait in a launching tier's body draws on the tier's allowance through `boundedMs`; a wait with its own literal is rejected.

## Enforcement

`structure` runs `structure:dead-code` (the root `knip.json`) and `structure:layering` (`.dependency-cruiser.mjs`: cycles, orphans, the import direction and boundaries above, folders outside [Layout](#layout)); CI runs them as two Turbo tasks with `--continue`. `lint` (`eslint.config.mjs`) carries the import bans and the gates below. A kept file nothing imports and that imports nothing takes, beside its `ignoreFiles` entry, its exact anchored path in `no-orphans`' `pathNot` with the same comment, never a directory or a pattern; both leave together.

The mechanical gates. Before adding or changing a gate, read its file set and lifts in [Desktop Structure §Mechanical Gates](../../docs/architecture/desktop-structure.md#mechanical-gates).

1. `window.desktopBridge` is read off the global only in `services/platform/live-bridge.ts`: `readInstalledBridge` there feeds `PlatformBridgeProvider`, from which every surface takes the bridge, and `readFixtureLaunch` there, called only by `app/fixture/composition.ts`, reads the fixture launch. An alias that dodges the selector is rejected in review.
2. No `setInterval` in renderer source.
3. No `export default` outside the package-root tool configs.
4. No module-level `let` in shipped renderer source.
5. `spawn` from `node:child_process` only in `tests/helpers/electron/child/child.ts`, which registers the kill on `onTestFinished`, and in `src/main/services/daemon/service/start.ts`, which starts the background service detached so it outlives the app.
6. No `toMatchScreenshot` matcher.
7. A `.css` import follows [Styling](#styling): its own folder's sheet, except from a chunk root and `main.tsx`.
8. No directory `import.meta.glob` under `src/`.
9. No text-snapshot matcher: it records whatever the code produced on its first run and passes. Assert the value.
10. Renderer file sections: exported types and interfaces, the exported class, the exported function, then everything private. A private type that exactly one helper uses may sit directly above that helper. The constants a file already has stay where they are.
11. Class order: fields, constructor, public methods, then everything else.
12. Windows are built only in `src/main/windows/window.ts`. `contextIsolation`, `sandbox` and `webSecurity` are written only as the literal `true`, `nodeIntegration` and `nodeIntegrationInWorker` only as the literal `false`.
13. `tests/` and `fixtures/` carry the renderer's time bans (see Chokepoints) and its exported-collection ban, and the test bans: no `enum`, no `export *`, no `export default`, no screenshot matcher (gate 6), no text-snapshot matcher (gate 9), and no dynamic `child_process` reach (gate 5).
14. No deep relative import (three or more `../`) in renderer source.
15. Only `app/App.tsx` reads `__FIXTURE_BUILD__` in renderer source.

A new gate states its file set and lifts in [Desktop Structure](../../docs/architecture/desktop-structure.md), never left to be found in the config. Structure enforcement admits two ESLint plugins: `eslint-plugin-perfectionist` (gates 10 and 11 only) and `eslint-plugin-check-file`. A reusable or exported component in its own file is held in review.
