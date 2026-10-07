# apps/desktop — structure rules

Binding for every change under `apps/desktop/`, on top of the [root `AGENTS.md`](../../AGENTS.md), which this file never restates. Paths are relative to `apps/desktop/` or the renderer root `src/renderer/src/`. Read [Desktop Structure](../../docs/architecture/desktop-structure.md) before adding a folder, moving a file, or adding or changing a lint or layering rule: it lists what each folder and feature holds and each check's exact scope. What each process does is in [Desktop Architecture](../../docs/architecture/desktop.md).

## Launching

`pnpm --filter @ai-sidekicks/desktop dev` runs the app on the renderer's dev server. After `--`, `--fixture <scenario>` plays a scenario from `fixtures/index.ts` and `--session <session-id>` opens one of its sessions; `src/main/fixture-launch.ts` checks both against the catalog. An unknown scenario, a missing value or a session the scenario lacks stops the launch before any window opens, with no fallback. Only the development build and `build:fixtures` carry scenarios; every other build refuses `--fixture`.

`pnpm --filter @ai-sidekicks/desktop package` builds and packages an unsigned `AI Sidekicks.app` into `dist/` (after the workspace packages are built, `pnpm build`). Unsigned means `mac.identity: null` in `electron-builder.yml`: electron-builder skips signing, and the fuse step's `resetAdHocDarwinSignature` still signs the app ad hoc, without which Apple silicon refuses to launch a binary whose fuses were flipped. On macOS electron-builder compiles `build/icon.icon` with `actool`, which only Xcode 26 or later has, so `xcode-select` must point at that Xcode and its license must be accepted. The package carries the hardened fuse wire, which `build/release-artifact-fuses.test.ts` reads from it.

## Before pushing

Run `test:changed <base-ref>` plus the files you authored, and `structure`, both under `pnpm --filter @ai-sidekicks/desktop run`. Before opening a PR, also run the root checks ([Working style](../../AGENTS.md#working-style)) and `pnpm -w exec eslint .`; every one clean. `test:changed` exits `2` with no ref or a file no project claims. `test:renderer` is the cheap headless tier; the aggregate `test` script and the Electron tiers it names are CI's.

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
- **A `services/` client is named for the contract it speaks** (`services/provider-accounts/`, an artifacts client in `services/artifacts/`), never for the feature that calls it; a call one feature alone makes stays in that feature's `services/`.
- **A hook** lives under its owner's `hooks/`. A file mixing hooks with other code is split when the other code is used without the hook.
- **Main.** `src/main/` keeps `index.ts`, `menu.ts` and `fixture-launch.ts` at its root and groups the rest into `windows/` (the one window factory and main's registry of windows), `bridge/` (main's handler for each preload bridge method), `appearance/` (the kept appearance record and the platform scheme it drives), `services/` and `probes/`; a further folder is made when its first file lands.
- **Package files outside `src/`.** `build/` holds the build's own TypeScript and tests and the packaging inputs: electron-builder's after-pack hook `build/browser-snapshot.ts`, which gives the main process its own V8 snapshot; the app icon `build/icon.icon`, an Icon Composer document (the neon robot with a voice-waveform mouth), and its glow layer's source `build/icon-glow.svg`. `resources/` holds the files main loads at run time: the About panel's app icon `resources/icon.png` on Windows and Linux, a 64-pixel export of `build/icon.icon`'s default appearance; the Dock icon of a development run on macOS, `resources/dock-icon.png`, the same appearance exported at 824 pixels and centered on a 1024-pixel canvas, the margin macOS keeps around an app icon; the macOS menu-bar icon's resting face `resources/menu-bar-idleTemplate.png` and `@2x`, one-color template images drawn from `resources/menu-bar-idle.svg`, which a packaged app carries beside its archive; and `resources/tray.svg`, the one-color outline of the app logo.
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
- **Package imports** (`#renderer/*`, `#main/*`, `#preload/*`, `#shared/*`, `#fixtures/*`, `#test/*`, `#scripts/*`) are defined once, in `package.json` `"imports"`, which Node, TypeScript, Vite, Vitest, knip and dependency-cruiser all read. An import across top-level folders uses one; one inside a feature or module stays `./`. No file in the package imports through three or more `../` (gate 14 checks the renderer). A file a tool loads itself (`vitest.config.ts`, `electron.vite.config.ts`, `.size-limit.ts` and every module they import, and everything under `build/` and `scripts/`) may use them too, naming the real file with its extension (`#scripts/budget/registry.mts`), since Node maps no `.js` specifier to a `.ts` source.
- **The process boundary.** The renderer requests, main owns the native windows, the daemon owns the work. The renderer holds no Electron, Node or filesystem authority; it reaches the `window.*` and `preview.*` contracts only through its `services/` clients, and gets `PlatformBridge`, which every host implements, from `PlatformBridgeProvider` (`usePlatformBridge`).
- **Renderer import bans.** Renderer code never imports `main/` or `preload/`, relatively or through `#main` / `#preload`, nor Electron, a Node builtin, or the daemon or control-plane package. `src/shared/**` may import the contracts package and nothing else (`shared-imports-nothing`): no Electron, Node builtin, React, daemon or control-plane package. Main and preload never import renderer code; a value both sides need lives in `src/shared/`.
- **Wire values are parsed in `services/`.** Elsewhere, renderer code imports neither `zod` nor a contracts schema (an export ending in `Schema`); a test may parse through a contracts schema to build or check contract-shaped data. A module that validates data it owns rather than a wire value may use `zod` once named in `eslint.config.mjs`, and still imports no contracts schema. The one named module, the approval fold `store/session/events/approval-flow-projection.ts`, reads approval payloads through their contracts schemas and imports no `zod`, until the approval card's build moves that read into `services/` and the allowance with it.

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
- **Refresh:** every refresh goes through `lib/reads/refresh/scheduler.ts`.
- **Time:** renderer code never calls `Date.parse` or `new Date(<string>)` and never orders time stamps as text.
- **Readings:** a reading is one class that publishes what a surface reads _and_ holds the daemon connection, the refresh scheduler and the `ReadTriggerTarget` members `triggeringEventKinds` and `requestRead`, so it can always be asked again. A class publishing only what an act settled holds none of them and is not a reading.
- **Daemon calls:** a surface reaches the daemon through `callDaemon` (`services/daemon/reply.ts`), which parses the reply against the method's schema and answers `served` or `refused`. A suite answering one method spreads a real bridge through `withDaemonCall` / `withDaemonSubscribe` in `tests/helpers/fixture/bridge.ts`, never its own.
- **Markup:** `components/Markdown/MathBlock.tsx` is the one `dangerouslySetInnerHTML` site (KaTeX's interface is a markup string); a second is rejected.
- **Scroll:** only `lib/scroll/chokepoint.ts` writes a scroll offset, and every write names its caller. No `scrollTop` write elsewhere and no `scrollIntoView`: glide through the chokepoint.

## State and views

- Stateful logic is an encapsulated class with private fields. A module-level `let`, `Map` or `Set` singleton and an exported collection are rejected in every desktop file; gate 4 lints the `let` in shipped renderer source, and review catches it everywhere else.
- React components are function components that render. Effects, subscriptions, derivations and store construction live in a class or a hook, never a render body.
- **One store never holds another store's flag.** The window store (one per window) and the session store (one per open session) never import each other and share no member name; the registry, hooks and schedulers above them compose the two.

## App design

Held in review; a checker would get both wrong.

- **Two hues carry attention, never a third:** amber, a person is needed; red, something failed. Every attention color is an `ATTENTION_ROLES` role in `src/shared/theme/palette.ts`, filled by each theme's table; the brand accent is one desaturated cyan, for interactive affordances and a running state. No stylesheet paints an attention treatment from its own hex, named color or raw `oklch()`; a raw `oklch(0% 0 0 / …)` in a `box-shadow` is an opacity, not a hue.
- **Copy is sentence case, never exclaims or celebrates.** A receipt states what happened: no exclamation mark, no congratulation, no Title Case run of three or more words.
- **A line is said only when what it reports changed after its view's first read settled.** The person's act, a state change pushed after the first read, the view's own first read failing (assertive) and the delayed loading line speak through the window's one announcer; what the first read or a replay draws, what a remounted row redraws and words drawn again as they last stood are plain text reached by browsing. A line, or a view's summary of its read, speaks through `AnnouncedLine` or `useAnnounceWhenChanged`, never a live role of its own, and a view marks what it opens with in `StandingContent`.

## Naming

- **Renames.** Beyond when the root rename rule allows ([Names](../../AGENTS.md#names)), an identifier, file, CSS class or token here also changes when it is unclear or its responsibility or owner changes.
- **Screens.** A destination's view is a screen (`Screen<Id, Params>`, `SessionScreen`, `AgentsScreen`), and "screen" names nothing else. `ScreenView` is only the frame region showing the screen the rail picked. Routing stays in `app/AppRouter.tsx`. A session's arrangement of panes is its pane layout, never "screen view" or "deck".
- **"Workspace"** means only the managed folder on disk a session is bound to; there is no `features/workspace/`.
- **`transcript` and `preview`** name the transcript and the Preview pane; a name about the real browser the pane drives keeps "browser".
- **Keybindings** are `Keybinding`, `keybinding`, `keybindings` in identifiers.
- **`shared`** means code both Electron processes use.

## Styling

Plain CSS on global design tokens in `styles/`. No `*.module.css`.

- A sheet one component owns is named for it and imported by it, beside it (`ChordHint.tsx` imports `./ChordHint.css`); a sheet renamed for a component moves its import to that component.
- Class families different components own split at that seam. One cohesive concern several components of a feature share stays one sheet, imported by the feature's top view or its lazily-loaded chunk root; a sheet is never split only because several components take part in one concern.
- A global sheet (a utility class, or a treatment shared components compose) lives in `styles/`, imported by `main.tsx`.
- No file imports another folder's sheet, except a chunk root and `main.tsx`.
- A CSS class has one owning stylesheet; two sheets declaring it at equal specificity resolve by load order.
- A treatment several features share is one class in a `styles/` sheet, applied beside the control's own class (the action button and disclosure trigger in `styles/action-buttons.css`). The control's class keeps only layout, state and variation; a class left with no rules is removed.
- A shared component owns every rule for its classes. A feature varies it through its modifier, `data-*` attribute or custom property, never by restyling the class from another sheet.
- A feature-private class carries the feature's name as its prefix when it is new or is already being renamed with the concept it names. Renaming a class or token follows [Naming](#naming).
- A custom property a component reads and a caller may set has a fallback (`var(--figure-wire-color, inherit)`); without one the declaration drops silently.

## Tests

- A test sits beside its subject as `*.test.ts(x)`, across `src/**`, `build/**` and `scripts/**`. Playwright runs inside Vitest as the Electron driver.
- `tests/` holds only tests spanning modules or the app: `helpers/` and the tiers `browser/`, `e2e/`, `endurance/`, `accessibility/`, `budget/`, one Vitest project each, globs disjoint. A test reading one scenario's data sits beside that scenario.
- Shared scaffolding lives once per role in `tests/helpers/`; a module one tier alone uses sits in that tier's folder; a tier hand-rolling a role another has is rejected. Helper tests sit beside their helpers in `main-unit`, except those needing the renderer's DOM: `RENDERER_TESTS_OUTSIDE_SOURCE` in `vitest/tier-projects.ts` moves them, and the scenario contract check's suite, to `renderer`.
- A test never reimplements the rule it checks or drives a stand-in for the module under test. Every clean result has a negative control that fails.
- A test launching Electron goes through `tests/helpers/electron/harness.ts`, `tests/helpers/smoke-probe/harness.ts` or `tests/lifecycle.gc.test-support.ts` (they set `SIDEKICKS_UNOBTRUSIVE_WINDOWS=1`, except a launch asking `isWindowOnScreen` for a test that presses the window with the system's own pointer). No `show()`, `showInactive()` or `focus()` outside `src/main/windows/reveal.ts`.
- A spawned child's lifetime belongs to the test (gate 5's module kills it on `onTestFinished`), and a spawner's deadline fires before its per-test budget.

## Executables and config

- Every file under `scripts/**` and `build/**` is TypeScript, run with `node --experimental-strip-types`, typechecked by `tsconfig.scripts.json` or `tsconfig.build.json`. No `.js`, `.mjs` or `.cjs` executable, no hand-written `.d.mts`. A file neither `pnpm build` runs nor a package script names belongs in `src/`.
- Budgets and their unit factors live in `tests/budget/document.json`, except the renderer bundle sizes, which live in `.size-limit.ts` and which size-limit checks; a test never restates a threshold.
- A new Vitest project lands with all five of `vitest.config.ts`, a `test:<project>` script, a Turbo task with `inputs`, a line in the aggregate `test` script, and a matrix entry in the `desktop` job of `.github/workflows/ci.yml` (`desktop-slow` for a nightly and `main`-only tier); a deliberate omission records its reason beside the registration. `exclude` spreads Vitest's default in.
- Tiers sharing `out/**` (`build`, `build:smoke`, `build:fixtures`) sit in separate matrix legs.
- A new `tsconfig*.json` reaches `typecheck` in the same commit; no two configs share an `outDir`; a `tsconfig` nothing reaches is deleted.
- A budget marked `enforced` is reachable from the aggregate `test` script and a CI job, its `measuredBy` naming a harness holding its subject; otherwise it is `n/a` naming the wiring task. Every renderer PR runs every tier whose subject is in-tree and reports an absent one `n/a`, except the accessibility and endurance tiers, which run only by name until the console-polish unit makes them gates on every PR.
- Every bounded wait in a launching tier's body draws on the tier's allowance through `boundedMs`; a wait with its own literal is rejected.

## Enforcement

`structure` runs `structure:dead-code` (the root `knip.json`) and `structure:layering` (`.dependency-cruiser.mjs`: cycles, orphans, the import direction and boundaries above, folders outside [Layout](#layout)); CI runs them as two Turbo tasks with `--continue`. `lint` (`eslint.config.mjs`) carries the import bans and the gates below. A kept file nothing imports and that imports nothing takes, beside its `ignoreFiles` entry, its exact anchored path in `no-orphans`' `pathNot` with the same comment, never a directory or a pattern; both leave together.

The mechanical gates; each one's file set and lifts are in [Desktop Structure §Mechanical Gates](../../docs/architecture/desktop-structure.md#mechanical-gates).

1. `window.desktopBridge` is read off the global only in `services/platform/live-bridge.ts`: `readInstalledBridge` there feeds `PlatformBridgeProvider`, and `readFixtureLaunch` there, called only by `app/fixture/composition.ts`, reads the fixture launch. An alias that dodges the selector is rejected in review.
2. No `setInterval` in renderer source.
3. No `export default` outside the package-root tool configs.
4. No module-level `let` in shipped renderer source.
5. `spawn` from `node:child_process` only in `tests/helpers/electron/child/spawner.ts`, which registers the kill on `onTestFinished`, and in `src/main/services/daemon/service/start.ts`, which starts the background service detached so it outlives the app.
6. No `toMatchScreenshot` matcher.
7. A `.css` import follows [Styling](#styling).
8. No directory `import.meta.glob` under `src/`.
9. No text-snapshot matcher: it records whatever the code produced on its first run and passes. Assert the value.
10. Renderer file sections: exported types and interfaces, the exported class, the exported function, then everything private. A private type that exactly one helper uses may sit directly above that helper. The constants a file already has stay where they are.
11. Class order: fields, constructor, public methods, then everything else.
12. Windows are built only in `src/main/windows/factory.ts`. `contextIsolation`, `sandbox` and `webSecurity` are written only as the literal `true`, `nodeIntegration` and `nodeIntegrationInWorker` only as the literal `false`.
13. `tests/` and `fixtures/` carry the renderer's time bans (see Chokepoints) and its exported-collection ban, and the test bans: no `enum`, no `export *`, no `export default`, no screenshot matcher (gate 6), no text-snapshot matcher (gate 9), and no dynamic `child_process` reach (gate 5).
14. No deep relative import (three or more `../`) in renderer source.
15. Only `app/App.tsx` reads `__FIXTURE_BUILD__` in renderer source.

A new gate states its file set and lifts in [Desktop Structure](../../docs/architecture/desktop-structure.md), never left to be found in the config. Structure enforcement admits two ESLint plugins: `eslint-plugin-perfectionist` (gates 10 and 11 only) and `eslint-plugin-check-file`.
