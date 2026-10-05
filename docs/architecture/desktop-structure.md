# Desktop Structure

## Purpose

The reference behind [`apps/desktop/AGENTS.md`](../../apps/desktop/AGENTS.md): what each folder of `apps/desktop` holds, and the exact scope of each check that enforces its rules. It also records how the repo-wide ESLint checks behind the root `AGENTS.md` Code conventions are scoped. The rules themselves are in those files; this document describes, and adds no rule of its own.

## Scope

The Electron main process, the preload, the code both share, the renderer, the fixtures and the tests. What each process does is in [Desktop Architecture](./desktop.md). Paths are relative to `apps/desktop/` or to the renderer root `src/renderer/src/`.

## The Package

```text
apps/desktop/
├── src/
│   ├── main/            the Electron main process
│   ├── preload/         the bridge the preload exposes to the renderer
│   ├── shared/          desktop-only contracts between main, preload and the renderer
│   └── renderer/
│       ├── index.html
│       └── src/         the renderer root
├── fixtures/            scenario definitions and scripted data, never shipped
├── tests/               tests that span modules or the application
├── build/, scripts/, vitest/, and the configs
└── package.json
```

## Renderer Folders

| Folder | What it holds |
| --- | --- |
| `app/` | `App.tsx`, `AppRouter.tsx` (the route switch), `AppProviders.tsx` (the provider stack), `AppBootstrap.tsx`, `AppWindow.tsx` (the window's stores, their bindings and the `AppShell` around the routed screen), `token-installation.ts` (installs the generated token sheet into the document), `registrations.ts`, and `hooks/` (the window's composition and bootstrap hooks only). In fixture builds only: `fixture/` (`composition.ts`, and `global-names.ts`, the page property names a fixture build hangs its handles on) and `pane-harness/`. |
| `layout/` | `AppShell/` (the frame, the three-column grid), `NavigationRail/`, `Header/` (where the header lives once it is built), `CommandPalette/` (the palette's UI; its command machinery is a registry and its commands are feature contributions) and `NotificationsList/`. |
| `features/` | `agents/`, `composer/`, `inspector/`, `preview/`, `repos/`, `sessions/`, `settings/`, `terminal/`, `transcript/`, `workflows/`; and `remote-control/` and `skills/`, where Remote Control's and Skills' screens live once they are built. |
| `registries/` | The mechanisms for panes, screens, inline cards, the composer, entity projectors, commands and keybindings. The screen view is one generic `ScreenView<S extends AnyScreen>` over a typed `Screen<Id, Params>` union, each case naming a rail destination and the parameters it opens with, so the compiler checks that whatever opens a screen hands it the right parameters. |
| `services/` | Transport, the daemon client, run streams, the per-session daemon subscription (`session-events/`), the platform bridge (`platform/`), and the other external clients (`wire-reads`, `driver-capabilities`, and `provider-accounts` for its deliveries and refusals only). The window client over the `window.*` contract, the Preview client over the `preview.*` contract and `approvals` live here once they are built. |
| `store/` | The applied session events (`session-events/`), attention (`attention/`), the window's own state (`window/`, `WindowStore`), persistence (`persistence/`), every read trigger and push-driven read (`reads/`), `session/`, `session-directory/`, `artifacts/`, `driver-capabilities/`, `provider-accounts/` (the account fold and the notification hold) and `subject-scoped/` (the session subject and the session-scoped state hook). |
| `hooks/` | Shared hooks, one `useThing.ts` each, and `subject-scoped/` (the subject-scoped resource and state hooks). `useReorderDrag.ts` is the pointer-drag core's hook. |
| `components/` | Shared UI, one PascalCase folder per component with its tests and CSS (`Glyph/`, `PaneFrame/`, `Refusal/` and `ErrorBoundary/` among them). |
| `routing/` | Route addresses and their parsing: `routes.ts` (the app's routes as data), `readers.ts`, `settings-page-ids.ts`, `panes/` (pane addresses and kinds) and `hooks/` (`useLocationHash`). |
| `assets/` | `assets/icons/signature/`, which the glyph map (`components/Glyph/glyph-icons.ts`) and the icon build step (`vitest/icon-compilation.ts`, the `signature` collection) read. |
| `styles/` | The design tokens and the sheet generated from them (`tokens.ts`, `palette.ts`, `typography.ts` and `generate-css.ts` among them), and the global sheets `global-sheets.ts` imports. |
| `lib/` | Generic non-UI code: time (`clock.ts`, `instant.ts`, `deadlines.ts`), wire figures and errors (`wire/`, with `wire/figures.ts`, `wire/errors.ts` and `wire/rejection.ts`), refusals (`refusal/`), the `Intl` formatter cache, keyed registries, read scheduling (`reads/`, with `reads/refresh/refresh-scheduler.ts`), the subject-scoped holders (`subject-scoped/`), the scroll chokepoint and its geometry (`scroll/`, with `scroll/chokepoint.ts`), `diagnostic-capture/` and `performance-meters/`. `reorder-drag.ts` is the pointer-drag core: the one drag every reorder inside a window uses — the terminal's and Preview's tabs, the waiting messages, the pane row and the session views — on pointer capture, the item moved by `transform` and its neighbors by FLIP, every listener on the item's own document; `reduced-motion.ts` reads a window's reduced-motion setting ([ADR-040](../decisions/040-drag-is-our-own-on-pointer-events.md)). |

What some features hold:

- `agents/` is the agents feature and its library, the screen a person sees as Sidekicks.
- `composer/` holds the composer with the approval card and the run controls.
- `inspector/` holds the inspector with its Cost and Rules sections.
- `preview/` is the Preview pane.
- `remote-control/` will hold the Devices page body (reached through the settings page registry), the machine and device cards, linking and the shared-ports list, once Remote Control's screens are built.
- `repos/` owns git and source control.
- `sessions/` owns the Sessions destination whole: the sessions list and the session screen (`SessionScreen.tsx`, `header/`, `pane-layout/`, `new-session/`).
- `settings/` holds the settings pages only.
- `skills/` will hold the Skills screen, once it is built.
- `terminal/` is split by responsibility into `emulator/`, `lease/` and `pane/`.
- `workflows/` holds `param-form/`, which only workflows uses.

## Inside a Feature

```text
features/<feature>/
├── <View>.tsx           the feature's top view or views, at the root, named for what each is
├── components/           the feature's other components, each with its plain .css beside it
├── hooks/                the feature's hooks, one useThing.ts each
├── services/             the feature's own external calls, only if it has any
├── contributions/        what the feature registers: panes.ts, commands.ts, keybindings.ts
├── fixtures/             the feature's fixture implementations, when it owns a replaced boundary
├── types.ts              types shared inside the feature, if any
├── index.ts              the feature's public entry, if it has one
└── <thing>.ts            non-UI logic the feature owns (models, folds, readers), named for what it holds
```

## Main, Preload and Shared

- **`src/main/`** holds `index.ts`, `menu.ts` and `fixture-launch.ts` at its root, and:
  - `windows/` — the one window factory and main's registry of windows, every window alike, with the navigation policy and the load-failure handling; `windows/places/` holds the window-place file and fitting a kept place onto the displays.
  - `appearance/` — main's appearance record, its file, and the platform scheme and first-frame grounds it drives.
  - `bridge/` — main's handler for each preload bridge method; `bridge/native/` holds the `native` namespace's handlers, with `bridge/native/editors/` for finding and opening the editors.
  - `services/` — main's own services: the diagnostic log, the crash reporter, the renderer's scheme and protocol (`services/renderer/`), and owner-only files; `services/daemon/` holds starting, supervising and linking to the background service, with `services/daemon/service/` for the service's program, process and detached start.
  - `probes/` — the smoke and garbage-collection probes, built only into the smoke bundle.
- **`src/preload/`** holds `index.ts`; `api.ts`, which builds the bridge object; and one module per namespace it carries to main over IPC (`daemon-wire.ts`, `machine-settings-bridge.ts`, `window-bridge.ts`).
- **`src/shared/`** holds flat files, `preload-api.ts` (`PreloadApi` and `createStubBridge`) among them, `daemon/`, the daemon call forwarding, method bindings and status topic, and `window/`, the window id's form and the window's size.

## Fixtures

- **`fixtures/`** holds `scenarios/<scenario>.ts`, one file per named scenario; shared `data/`; and `index.ts`, the scenario catalog.
- **Fixture implementations** are `services/<service>/<service>.fixture.ts`, a feature's `fixtures/` folder, or the store's owner where the store boundary itself is replaced. The release build drops every `features/**/fixtures/` by path.

## Mechanical Gates

The numbers match `apps/desktop/AGENTS.md` and the ESLint messages that cite them. Each gate's scope:

1. Five spellings — `window.desktopBridge`, `globalThis.desktopBridge`, the cast form `(window as { desktopBridge?: … }).desktopBridge`, the computed key `globalThis["desktopBridge"]`, and the destructure `const { desktopBridge } = window` — are banned across the renderer except in `services/platform/live-bridge.ts`, and lifted for its test files, which install a fixture bridge on the global as the substitution seam. `PlatformBridgeProvider` calls `readInstalledBridge` there; the fixture launch the preload exposes is read there too, by `readFixtureLaunch`, which only `app/fixture/composition.ts` calls. An alias (`const w = window; w.desktopBridge`) evades every selector.
2. Renderer source, both spellings: the bare global and `window` / `globalThis`-qualified.
3. Everywhere but the package-root tool configs, which their tools load by default export. Off for `**/*.d.ts`, where the `export default` inside an ambient `declare module` types a default-exporting virtual module.
4. Shipped renderer source. Lifted for `*.test.{ts,tsx}` and `*.test-support.{ts,tsx}`: a `let` reassigned in `beforeEach` is the standard Vitest shape and holds no state anything else can reach.
5. The static import, the dynamic `import()` and the `require` form alike, across `tests/**`, `src/main/**` and `scripts/**`. `spawnSync` is untouched: it settles before the next statement and leaves no child to own. One lift beyond `tests/helpers/electron/child/child.ts`: `src/main/services/daemon/service/start.ts`, main's start of the background service, whose child is detached to outlive the app on purpose; a test that starts it kills it by process id in teardown.
6. The `toMatchScreenshot` matcher, everywhere. A never-saved `page.screenshot({ save: false })` read is a measurement, not a capture, and is outside the rule.
7. Relative and `#renderer/` specifiers; a chunk root is `*-body.{ts,tsx}`. A vendor sheet reached by package specifier is outside the rule. Which file in a folder imports the sheet is a review point.
8. The literal carries a `*`, so a raw read of one named module is untouched.
9. `toMatchSnapshot`, `toMatchInlineSnapshot` and `toMatchFileSnapshot`, in the property and the computed-key spelling, across every directory `lint` reads: `src/**` (main, preload and shared included, through the widest `src` block), `tests/**`, `fixtures/**`, `scripts/**`, `build/**` and `vitest/**`, because the `main-unit` project's `include` reaches outside the renderer. A text snapshot records whatever the code produced on its first run and passes.
10. `src/renderer/src/**`, co-located tests included, through `eslint-plugin-perfectionist`'s `sort-modules`. Only exported forms are ranked; every non-exported declaration shares one trailing bucket left in source order, so a private type may sit directly above its one helper. A module-level constant is not positioned: the rule has no variable selector and treats every `const` as a partition boundary it moves nothing across.
11. The same file set, through `sort-classes`. Fields include index signatures, static blocks, and accessor and function properties. An accessor ranks with the methods of its own accessibility; `protected` ranks with `private`. An absent keyword reads as public and a `#` member as private.
12. `src/main/**`. No `new BrowserWindow`, `BaseWindow` or `WebContentsView` outside the window factory, which holds the one locked `webPreferences` block. `contextIsolation`, `sandbox` and `webSecurity` are written only as the literal `true`, and `nodeIntegration` and `nodeIntegrationInWorker` only as `false`, so a variable in their place is refused. The window test and the smoke launch prove the shipped window carries them.
13. `tests/**` and `fixtures/**`: no `Date.parse`, no `new Date(<string>)`, no stamp ordered as text, the exported-collection ban, and the test bans: no `enum`, no `export *`, no `export default`, no screenshot matcher (gate 6), no text-snapshot matcher (gate 9), and no dynamic `child_process` reach (gate 5). The time bans are lifted for `tests/helpers/process-tree/**`, which reads the start stamp `ps` prints in the host's zone.
14. Three or more `../` segments, at any depth, in `src/renderer/src/**`.
15. A restricted global in `src/renderer/src/**`, lifted for `app/App.tsx`.

Gates 10 and 11 sort nothing within a section and add or remove no blank line.

Two renderer bans ride the same selectors without a number of their own: the time bans (no `Date.parse`, no `new Date(<string>)`, no stamp ordered as text) and the exported-collection ban (no exported `Set`, `Map`, `WeakSet` or `WeakMap` built with `new`; a collection a module keeps to itself is untouched by the lint, and review still rejects a module-level singleton). Both cover `src/renderer/src/**/*.{ts,tsx}`, co-located tests included. The time bans are lifted for `src/renderer/src/lib/instant.test.ts`, whose negative controls call the banned API to show what it answers.

## Other Checks

- **dependency-cruiser** (`.dependency-cruiser.mjs`, layers in `.dependency-cruiser.layers.mjs`): one `layering-<folder>` rule per rung of the import direction (a renderer module importing from any folder above its own), `feature-isolation`, `feature-public-api-only`, `store-isolation` (both directions, any depth, on resolved paths), `renderer-top-level-folders` (a module outside the renderer folders, or a root file other than `main.tsx` and its two ambient declarations), `app-is-composition-only`, `renderer-not-main` and `main-not-renderer`, `shared-imports-nothing`, the fixture import boundary, `test-support-has-no-shipping-reader` (a module under `src/` that is not itself `.test-support` importing a `.test-support` module or anything under `tests/`; test files are outside the graph, so any importer it reports ships), `fixture-stylesheet-outside-its-folder` (a module in one feature's `fixtures/` importing a stylesheet under another feature's `fixtures/`), `fixture-stylesheet-from-outside-any-fixtures-folder` (a module outside every feature's `fixtures/` importing a stylesheet under one), `no-barrel-chain`, `no-circular` and `no-orphans`.
- **ESLint restricted imports** (`eslint.config.mjs`): the renderer may not reach `main/` or `preload/`, relatively or through `#main` and `#preload`, nor import Electron, Node builtins or the daemon and control-plane packages; `src/shared/**` carries the same ban, because it is bundled into the renderer, and dependency-cruiser's `shared-imports-nothing` lets it import the contracts package and nothing else (no Electron, Node builtin, React, daemon or control-plane package). `zod` and contracts schemas are confined to `services/`, with the named-module allowances.
- **Repo-wide ESLint** (root `eslint.config.mjs`): `ENUM_DECLARATION` refuses an `enum` and `EXPORT_ALL_DECLARATION` refuses `export *` in every authored TypeScript file but `*.d.ts`; `@typescript-eslint/naming-convention` refuses an `I`-prefixed interface (an acronym such as `IPCClient` passes). Line width is Prettier's `printWidth` in `prettier.config.js`.
- **File and folder names** (`eslint-plugin-check-file` in the root `eslint.config.mjs`): kebab-case for every file and folder outside the renderer, with `__tests__/` in the packages and the repository's tooling and `__fixtures__/` in the packages; in the renderer, PascalCase for a `.tsx` under `app/`, `components/`, `features/` or `layout/` that is not a test, test support or hook, and for a folder directly under `components/` or `layout/`; `useThing` for a file in a `hooks/` folder that is not test support; kebab-case, PascalCase or `useThing` for any other file, and kebab-case for any other folder; no `.spec` file anywhere. `requireJsxInTsx` adds a `no-restricted-syntax` selector that refuses a `.tsx` file with no JSX.
- **Not checked by lint:** a reusable or exported component in its own file. `react-refresh/only-export-components` checks a different property — that a module exporting a component exports only components, a Fast Refresh constraint — so the rule is held in review.

## Related Docs

- [Desktop Architecture](./desktop.md)
