# Desktop Structure

## Purpose

Define where code lives in `apps/desktop`, who owns it, how it is named, and which way imports may point.

## Scope

This document covers the Electron main process, the preload, the code both share, the renderer, the fixtures, and the desktop's tests. What each process does is in [Desktop Architecture](./desktop.md). Paths below are written as code, relative to `apps/desktop/` or to the renderer root `src/renderer/src/`.

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

`src/renderer/src/` stays the renderer root; it is never flattened into `src/renderer/`.

## Renderer Folders

At the root of `src/renderer/src/`: `main.tsx`, `desktop-bridge.d.ts` and the renderer's environment declarations. Everything else sits in one of these folders:

| Folder | What belongs there |
| --- | --- |
| `app/` | Composition and bootstrap only: `App.tsx`, `router.tsx` (the route switch), `providers.tsx` (`AppProviders`), `AppBootstrap.tsx`, and `registrations.ts`, which calls each feature's registration and holds no table and no lookup. `app/hooks/` holds only the window's composition and bootstrap hooks; a hook anything else could reuse goes to `hooks/`. In fixture builds only: `fixture-composition.ts` and `pane-harness/`. |
| `layout/` | Persistent chrome only: `AppShell/` (the frame, the three-column grid), `NavigationRail/`, `Header/`, `CommandPalette/` (the palette's UI; its command machinery is a registry and its commands are feature contributions) and `NotificationsList/`. |
| `features/` | User-facing capabilities, one folder each: `agents/`, `composer/`, `inspector/`, `preview/`, `remote-control/`, `repos/`, `sessions/`, `settings/`, `skills/`, `terminal/`, `transcript/`, `workflows/`. |
| `registries/` | The generic registration mechanisms only: `registerX` and `getX` with their types and read hooks, for panes, screens, settings pages, inline cards, the composer, entity projectors, commands and keybindings. No `index.ts`; importers use the declaring modules. |
| `services/` | External communication only: transport, the daemon client, run streams, the per-session daemon subscription (`session-events/`), the platform bridge (`platform/`), the window client over the `window.*` contract, the Preview client over the `preview.*` contract, and the other external clients (`wire-shapes`, `wire-reads`, `approvals`, `driver-capabilities`, and `provider-accounts` for its deliveries and refusals only), each with its fixture implementation beside it. |
| `store/` | App-wide projections and state only: the applied session events (`session-events/`), attention (`attention/`), the window's own state (`window/`, `WindowStore`), persistence (`persistence/`), every read trigger and push-driven read (`reads/`), `session/`, `session-directory/`, `artifacts/`, `driver-capabilities/`, `provider-accounts/` (the account fold and the notification hold) and `subject-scoped/` (the session subject and the session-scoped state hook). |
| `routing/` | Route addresses and their parsing. |
| `components/` | Shared UI, one PascalCase folder per component, holding the component, its tests and its plain CSS. |
| `hooks/` | Shared hooks. |
| `lib/` | Generic non-UI code. |
| `styles/` | The design tokens. |
| `assets/` | `assets/icons/signature/` only: the icon SVGs, which the glyph map (`components/Glyph/glyph-icons.ts`) and the icon build step (`vitest/icon-compilation.ts`, the `signature` collection) read. |

What some features hold:

- `agents/` is the agents feature and its library, the screen a person sees as Sidekicks.
- `composer/` holds the composer with the approval card and the run controls.
- `inspector/` holds the inspector with its Cost and Rules sections.
- `preview/` is the Preview pane.
- `remote-control/` holds the Devices page body (reached through the settings page registry), the machine and device cards, linking and the shared-ports list.
- `repos/` owns git and source control.
- `sessions/` owns the Sessions destination whole: the sessions list and the session screen (`SessionScreen.tsx`, `session-header/`, `pane-layout/`, `new-session/`).
- `settings/` holds the settings pages only.
- `skills/` holds the Skills screen.
- `workflows/` holds `schema-form/`, which only workflows uses.

A feature is a cohesive user-facing capability or workflow. A domain object alone never makes a feature, and a backend noun never makes a renderer folder. No other top-level folder is added without a concrete ownership or dependency need.

## Ownership

Every file lives with its narrowest owner, proven by its importers. A file one feature imports lives in that feature; a shared folder holds only what two or more owners import.

| What it is                                | Where it goes         |
| ----------------------------------------- | --------------------- |
| Owned by one feature                      | `features/<feature>/` |
| Persistent application chrome             | `layout/`             |
| Composition and bootstrap                 | `app/`                |
| A registration mechanism                  | `registries/`         |
| External communication                    | `services/`           |
| Shared UI                                 | `components/`         |
| A shared React hook                       | `hooks/`              |
| Generic non-UI code                       | `lib/`                |
| Code main, preload and the renderer share | `src/shared/`         |

- **Contributions stay with their feature.** What a feature registers (its panes, screens, commands, keybindings, settings pages) lives in `features/<feature>/contributions/`, one file per registry (`panes.ts`, `commands.ts`, `keybindings.ts`) when substantial. `app/registrations.ts` performs the final composition by calling each feature's registration.
- **`services/` is external communication only:** the daemon client, the platform bridge, transport and run streams, each with its fixture implementation beside it. Nothing goes to `services/` because it imports the bridge, the store or `lib/`; domain reads, selectors, projections, identities and view models go to their owning feature, `store/` or `lib/` by responsibility.
- **No feature imports another,** including its `index.ts`. What two features share goes through `registries/`, or down to `components/`, `hooks/`, `store/` or `lib/` when it is really shared. The session screen composes the composer, the transcript, Preview and the terminal through `app/` and the pane, contribution and registry seams; `features/sessions/` never imports them.
- **A list several features read is app-wide state.** The agent definitions and the skills are daemon readings: `services/daemon/` reads them and keeps them current into `store/`, and each feature reads them from there. No feature exports a list another feature draws; a control two features draw alike is one component in `components/`, with its non-UI logic in `lib/`.
- **Attention is app-wide.** The Notifications list holds sessions and workflow runs, so its projection, count and notifier live in `store/attention/`, mounted by `app/`, and its presentation is `layout/NotificationsList/`.
- **A limit constant goes to its narrowest owner:** a protocol or cross-boundary value to its contract or shared owner, a feature's limit to that feature, an app-wide implementation limit to the shared module that uses it.
- **An overlay goes by ownership:** a wrapper one feature uses lives in that feature; one reused by unrelated features stays in `components/`.
- **No dumping-ground folders:** no `utils/`, `helpers/`, `common/`, `misc/` or `managers/`. `tests/helpers/` is the one exception. In the desktop, `shared` means code both Electron processes use.

## Inside a Feature

A folder is added only when needed.

```text
features/<feature>/
├── <Feature>Page.tsx     the feature's top view or views, at the root
├── components/           the feature's other components, each with its plain .css beside it
├── hooks/                the feature's hooks, one useThing.ts each
├── services/             the feature's own external calls, only if it has any
├── contributions/        what the feature registers, when substantial
├── types.ts              types shared inside the feature, if any
├── index.ts              the feature's intentional public API, named exports only
└── <thing>.ts            non-UI logic the feature owns (models, folds, readers), named for what it holds
```

A large feature with several distinct responsibilities has one sub-folder per responsibility, named for it and shaped the same inside: the terminal's `emulator/`, `lease/` and `pane/`.

A hook lives in a `useThing.ts` file under its owner's `hooks/`. A file that mixes hooks with other code is split when the other code is used without the hook.

## Main, Preload and Shared

- **`src/main/`** holds `index.ts`, `menu.ts` and `fixture-launch.ts` at its root, and groups the rest into `windows/` (the one window factory and main's registry of windows, every window alike, with the navigation policy and the load-failure handling), `services/` and `probes/`. A further folder is added only when its first file lands.
- **`src/preload/`** holds `index.ts`, which is the expose call alone, and `api.ts`, which builds the bridge object. It has no `types.ts`: the type of what it exposes is `PreloadApi` in `src/shared/`.
- **`src/shared/`** holds the desktop-only contracts between main, preload and the renderer: `preload-api.ts` (`PreloadApi` and `createStubBridge`) at its root, `constants/` for values both processes read (such as the shutdown budget), and `ipc/` for the channel names of cross-process channels when one exists. A type that belongs to one module stays beside it.
- **Contracts live by boundary.** `packages/contracts` holds what crosses a boundary between independently built surfaces, or is a wire enum or schema; two consumers alone never justify it. `src/shared/` holds desktop-only contracts; a front-end type lives in the renderer.
- **The process boundary.** The renderer requests, main owns the native windows, and the daemon owns the work. The renderer reaches the `window.*` and `preview.*` contracts only through its `services/` clients and holds no Electron, Node or filesystem authority. The front end has one bridge, `PlatformBridge` (`services/platform/platform-bridge.ts`), which every host implements; the renderer receives it through `PlatformBridgeProvider` (`usePlatformBridge`), and the desktop's implementation, `services/platform/live-bridge.ts`, is the only reader of `window.desktopBridge`.

## Fixtures

The fixture system conforms to production boundaries and never defines them.

- **`fixtures/`** holds scenario definitions and scripted data only: `scenarios/<scenario>.ts`, one file per named scenario; shared `data/`; and `index.ts`, the scenario catalog. It is never shipped: a release build carries no fixture code and no catalog.
- **A fixture implementation sits beside the real owner it substitutes:** `services/<service>/<service>.fixture.ts`, a feature's `fixtures/`, or the store's owner where the store boundary itself is what gets replaced. `app/fixture-composition.ts` chooses the fixture implementations once, at startup; there is no `if (fixture)` anywhere else.
- **No `demo/`, no fake backend layer and no generic fixture method catalog.** Fixture-only types stay in `apps/desktop`, never in `packages/contracts`. Code says `fixture` and `scenario`, never `demo`. A scenario is named for the stable behavior it exercises, never for an incidental count or sample content.
- **The import boundary.** `fixtures/` imports from `src/` only as types. Only these import `fixtures/`: the fixture implementations (`*.fixture.ts`); `app/fixture-composition.ts` and `app/pane-harness/`; `tests/`; and `src/main/fixture-launch.ts`, which reads `--fixture <scenario>` and `--session <session-id>` and checks the name against the catalog. The rest of `src/main/` does not import `fixtures/`.
- **The launch.** `--fixture <scenario>` starts the fixture composition playing that scenario, and `--session <session-id>` opens one of its sessions. An unknown scenario, a missing value or a session the scenario does not hold is a startup error, with no fallback; a build without fixture capability refuses `--fixture` the same way.

## Naming

- **File names.** Components and pages `PascalCase.tsx`, one component per file; component folders `PascalCase/`; hooks `useThing.ts`; other modules `kebab-case.ts`; folders `kebab-case/`; tests `Foo.test.tsx` and `foo.test.ts`. `.tsx` only when the file has JSX.
- **Names read as English.** Things that act (functions, hooks, controls) start with the verb: `takeShell`, `useTakeShell`. Things that hold data (types, state, models) are noun phrases with the head noun last: `TakeShellAvailability`, `lease-model.ts`. A verb is never forced into a noun. Booleans read as questions: `isHeld`, `canTake`. Full words, no abbreviations.
- **No cosmetic renames.** These rules govern new names and names already changing. An existing name changes when it is unclear, inaccurate or obsolete, or when its responsibility or owner changes; never only to start with a verb or read as a question.
- **Name by responsibility and owner,** never by swapping one word for another. A thing is named for what it is, never for a generic structure word (`seat`, `slot`, `door`, `plane`, `surface`, `family`, `deck`, `Host`), and no new generic word (`Act`, `State`, `Surface`, `Feature`) takes their place; "screen" names only a destination's view. "Control plane" is the real name of `packages/control-plane`.
- **`Console` is not a prefix on code structure.** It stays only where it is the product's own term.
- **Screens.** A destination's view is a screen: `Screen<Id, Params>`, `SessionScreen`, `AgentsScreen`. `ScreenView` names only the one region of the frame that shows whichever screen the rail picked. Routing stays in `app/router.tsx`. A session's own arrangement of panes is its pane layout, never "screen view" or "deck".
- **"Workspace"** means only the managed folder on disk a session is bound to; there is no `features/workspace/`.
- **`shell`** means a terminal or command shell. The Electron main process is `main`; persistent UI chrome is `layout` or `AppShell`.
- **`transcript` and `preview`** are the feature names for the transcript and the Preview pane. A name about the real web browser the pane drives keeps "browser".
- **The design's words.** A name uses the design's word for the thing, and on-screen text uses the design's exact words. A product screen's folder, component, id, address, label and heading carry the design's name for it; an implementation concept keeps its conventional engineering name.
- **Agent in code.** Identifiers and technical text say agent, and a saved one is an agent definition. "Sidekicks" appears only as the name of the screen and destination a person sees.
- **Keybindings** are `Keybinding`, `keybinding` and `keybindings` in identifiers.
- **American spelling** everywhere: code identifiers, CSS, on-screen text and docs (`color`, `behavior`, `canceled`, `organization`). A spelling a provider's wire sends stays as the provider sends it.
- **CSS classes and tokens change by meaning.** A class or token is renamed when its name is inaccurate or tied to an obsolete or renamed concept, together with its consumers, with the styling unchanged.
- **`index.ts`** holds named exports only: no `export *` and no barrel chains, so an `index.ts` never re-exports another `index.ts`. A shared component's folder gets an `index.ts` only when it has an intentional public API.
- **Renaming an exported name** goes through the TypeScript language service's rename, so every reference changes with it and the typecheck proves it.

## Styling

The CSS is plain CSS on global design tokens. A component's `.css` sits beside it, and the tokens live in `styles/`. No `*.module.css` file is created.

## Tests

- **A test sits beside its subject** as `*.test.ts` or `*.test.tsx`. Nothing is `.spec.ts`: Playwright runs inside Vitest as the Electron driver. The desktop has no `__tests__/` folders; the packages keep theirs.
- **`tests/`** holds only tests that span modules or the application: `helpers/`, `browser/`, `e2e/`, `endurance/`, `screenshot/`, `accessibility/`, `budget/`, `bench/`, and `scenarios/` (tests that import a scenario from `fixtures/` and never hold scenario data or a catalog entry of their own).
- **Test support.** A `*.test-support.ts` helper serves one subject's tests and sits beside that subject. A helper several modules use lives in `tests/helpers/`, named for what it provides (`electron-driver.ts`, `render-app.tsx`) without the suffix. No suffix is added or removed mechanically.

## Imports

- **Aliases:** `@renderer/*` → `src/renderer/src/*`, `@main/*` → `src/main/*`, `@preload/*` → `src/preload/*`, `@shared/*` → `src/shared/*`, and `@test/*` → `tests/*`. They are defined once, in `tsconfig.paths.json`; `vitest/path-aliases.ts` turns that table into the `resolve.alias` the build and every Vitest project use, and dependency-cruiser resolves through the same file.
- **When to use which.** An import that crosses from one top-level folder to another uses the alias. An import inside a feature or module stays `./`. No deep relative import (`../../../`).
- **The import direction:** `shared → lib/styles/assets → routing → components/hooks → store → services → registries → features → layout → app`. Each folder imports only folders before it. `services/` may import the store's types, since the store sits below it; `layout/` imports nothing from `app/`.
- **Features never import features,** including another feature's `index.ts`.
- **No Electron or Node in the renderer.** Renderer code never imports Electron or Node APIs; Electron access goes through the typed preload API, which only the platform bridge's desktop implementation reads.
- **`index.ts` is a feature's public entry,** with named exports only and no barrel chains.

## Enforcement

- `.dependency-cruiser.mjs` (`structure:layering`) enforces the import direction, feature isolation and the fixture import boundary.
- ESLint's restricted imports (`lint`, configured in `eslint.config.mjs`) keep the renderer from reaching `main/` or `preload/`, relatively or through `@main` and `@preload`, and from importing Electron, Node builtins or the daemon and control-plane packages.
- knip (`structure:dead-code`, configured in the root `knip.json`) reports unused files and exports.

## Related Docs

- [Desktop Architecture](./desktop.md)
