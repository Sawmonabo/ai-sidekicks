// Package-scoped ESLint flat config for `@ai-sidekicks/desktop`.
//
// It enforces the renderer-untrusted boundary at the import surface: every Node, Electron,
// main-process and preload capability reaches the renderer only through `window.desktopBridge`
// (declared in `src/preload/index.ts`). Renderer source that imports Node or Electron APIs, or
// escapes by relative path into `src/main/**` or `src/preload/**`, fails
// `pnpm --filter @ai-sidekicks/desktop lint`.
//
// The ban applies to `src/renderer/src/**` and to `src/shared/**`: main and preload legitimately
// depend on `electron` and `node:*`, but a shared module is bundled into the renderer and carries
// its constraints. The `files` selectors of the blocks below narrow the scope.
//
// Ban list: `electron`, every `node:*` specifier, the bare Node built-ins (`fs`, `child_process`,
// `net`, `os`, `path`, `process`), and relative-path escapes into `**/main/**` and `**/preload/**`.
// `@ai-sidekicks/runtime-daemon` and `@ai-sidekicks/control-plane` are banned too: the renderer
// reaches both only through the bridge, and a per-component source scan cannot see a violation
// reached through a local helper, while lint traverses every renderer file.
//
// This config spreads the root `eslint.config.mjs` first, so it inherits the `@eslint/js` and
// `typescript-eslint` baselines, the repo-wide `ignores`, the shared `languageOptions` and the enum
// ban (which every block below that sets `no-restricted-syntax` restates). It inherits no
// `no-restricted-imports`: the root's blocks are path-scoped to `packages/`, so every import
// restriction that applies here is declared below in full.
//
// Flat-config resolution: for a file, ESLint applies the last config object whose `files` match,
// and an object that supplies rule options replaces the earlier options wholesale, with no deep
// merge and no union of `paths` or `patterns`. Each block below is therefore self-contained. The
// wire-parsing block restates the renderer ban by spreading the arrays hoisted below rather than
// copying them, so a ban added to the renderer list reaches it too.
import {
  EXPORTED_COLLECTION_SELECTOR,
  TIME_READING_EXEMPT_FILES,
  TIME_READING_SELECTORS,
} from "./eslint.restricted-syntax.mjs";
import { defineConfig } from "eslint/config";
import perfectionist from "eslint-plugin-perfectionist";
import root, { ENUM_DECLARATION, requireJsxInTsx } from "../../eslint.config.mjs";

/**
 * The bare specifiers renderer source may not import. Hoisted so the wire-parsing block can extend
 * the list instead of restating it: flat config replaces a rule's options at the last matching
 * object, so a shorter list there would silently delete every entry it forgot.
 */
const RENDERER_RESTRICTED_PATHS = [
  {
    name: "electron",
    message:
      "The renderer is untrusted: `electron` must NEVER be imported from renderer source. Route through the preload bridge (`window.desktopBridge`) instead. See apps/desktop/src/preload/index.ts.",
  },
  {
    name: "fs",
    message:
      "The renderer is untrusted: Node built-in `fs` is forbidden in renderer source. Route through the preload bridge.",
  },
  {
    name: "child_process",
    message:
      "The renderer is untrusted: Node built-in `child_process` is forbidden in renderer source. Route through the preload bridge.",
  },
  {
    name: "net",
    message:
      "The renderer is untrusted: Node built-in `net` is forbidden in renderer source. Route through the preload bridge.",
  },
  {
    name: "os",
    message:
      "The renderer is untrusted: Node built-in `os` is forbidden in renderer source. Route through the preload bridge.",
  },
  {
    name: "path",
    message:
      "The renderer is untrusted: Node built-in `path` is forbidden in renderer source. Route through the preload bridge.",
  },
  {
    name: "process",
    message:
      "The renderer is untrusted: Node built-in `process` is forbidden in renderer source. Route through the preload bridge.",
  },
  {
    name: "@ai-sidekicks/runtime-daemon",
    message:
      "The renderer is untrusted: the daemon package must NEVER be imported from renderer source (directly or through a local helper). Route through the preload bridge (`window.desktopBridge.daemon`).",
  },
  {
    name: "@ai-sidekicks/control-plane",
    message:
      "The renderer is untrusted: the control-plane package must NEVER be imported from renderer source (directly or through a local helper). The control plane is reached through the background service, never from renderer source.",
  },
];

/** The specifier GROUPS renderer source may not import. Hoisted for the same reason. */
const RENDERER_RESTRICTED_PATTERNS = [
  {
    // Electron subpath entrypoints (`electron/renderer`, `electron/main`, and any nested subpath).
    // `no-restricted-imports` treats a bare specifier and its subpaths as distinct, so the `paths`
    // entry for `electron` does not cover them. `**` matches across slashes (gitignore-style), so
    // this catches every present and future subpath.
    group: ["electron/**"],
    message:
      "The renderer is untrusted: `electron` (and any `electron/*` subpath) must NEVER be imported from renderer source. Route through the preload bridge (`window.desktopBridge`) instead. See apps/desktop/src/preload/index.ts.",
  },
  {
    // The rule treats `fs` and `node:fs` as distinct specifiers, so `paths` bans the bare forms and
    // this glob bans every `node:*` specifier and its subpaths (`node:fs`, `node:fs/promises`,
    // `node:stream/web`).
    group: ["node:**"],
    message:
      "The renderer is untrusted: `node:*` protocol imports (and their subpaths, e.g. `node:fs/promises`) are forbidden in renderer source. Route through the preload bridge.",
  },
  {
    // Subpaths of the two banned workspace packages, which the `paths` entries do not cover
    // (`@ai-sidekicks/control-plane/router`). Same `**` semantics as the `electron/**` group.
    group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
    message:
      "The renderer is untrusted: daemon / control-plane package subpaths are forbidden in renderer source. Route through the preload bridge (`window.desktopBridge`).",
  },
  {
    // Escape into the main and preload subtrees, relative or through their aliases (`../main/x`,
    // `@main/x`). `**` matches zero or more path segments, so any depth is caught. The only
    // legitimate cross-process channel is `window.desktopBridge`.
    group: ["**/main/**", "**/preload/**", "@main/**", "@preload/**"],
    message:
      "The renderer is untrusted: imports into `main/**` or `preload/**`, relative or through `@main` / `@preload`, are forbidden. The renderer's only cross-process surface is the `window.desktopBridge` bridge.",
  },
];

/** The `zod` library, which a surface never needs to parse a wire value. */
const ZOD_IMPORT = {
  // Bare specifier and every subpath (`zod/v4`, `zod/mini`) in one group, since the rule treats
  // them as distinct.
  group: ["zod", "zod/**"],
  message:
    "A surface never parses a wire value itself. Reach the daemon through `callDaemon` from `services/daemon/daemon-reply.ts`, which parses the reply against the method's registered schema and answers `served` or `refused`; a value that needs a shape needs a registry row, not a local validator.",
};

/** A contracts schema, which is a parser; types and non-schema values stay importable. */
const CONTRACTS_SCHEMA_IMPORT = {
  // The same claim as the `zod` group, on the schemas the contracts package already built. It is a
  // `patterns` entry because that is where the rule's schema puts `importNamePattern` (`paths`
  // items admit only `importNames`, measured on the installed engine), and an exhaustive
  // `importNames` list would go stale with the package's next schema.
  group: ["@ai-sidekicks/contracts"],
  // Every schema the reply registry composes, and every other schema the package exports, ends this
  // way: the suffix is how this repository spells a parser.
  importNamePattern: "Schema$",
  message:
    "A surface never parses a wire value itself, and a contracts schema is a parser. Reach the daemon through `callDaemon` from `services/daemon/daemon-reply.ts`, which parses the reply against the method's registered schema and answers `served` or `refused`; a value that needs a shape needs a registry row, not a second reading of one. Types and non-schema values from this package are untouched.",
};

/**
 * The groups a renderer module outside `services/` may not import: the renderer's, plus
 * the two that keep wire parsing out of a surface. Flat config replaces a rule's options
 * at the last matching block, so each narrower block below spreads these instead of
 * copying them.
 */
const RENDERER_WIRE_RESTRICTED_PATTERNS = [
  ...RENDERER_RESTRICTED_PATTERNS,
  ZOD_IMPORT,
  CONTRACTS_SCHEMA_IMPORT,
];

/**
 * Reading the preload bridge off the window.
 *
 * `services/platform/live-bridge.ts` is the one renderer module that may: the platform bridge
 * provider calls its `readInstalledBridge` and hands the result down as context, so the provider
 * distributes the bridge and the live bridge reads it. A second reader is a second idea of when the
 * bridge exists, what it does before it does, and which fixture stands in for it under test.
 *
 * Five arms, because one spelling of the read is one identifier away from useless: a member read
 * off `window` or `globalThis`, a cast (`(window as { … }).<name>`, whose object is a
 * `TSAsExpression`, so the arm keys on the cast alone), a computed key, and a destructure
 * (`const { <name> } = window;`, which performs no member read).
 *
 * An alias (`const w = window; w.desktopBridge`) is not closable by a selector, since esquery
 * cannot know what `w` holds; `apps/desktop/AGENTS.md` states it beside the rule.
 */
const BRIDGE_GLOBAL_READ = {
  selector:
    ':matches(MemberExpression[object.name="window"][property.name="desktopBridge"], MemberExpression[object.name="globalThis"][property.name="desktopBridge"], MemberExpression[object.type="TSAsExpression"][property.name="desktopBridge"], MemberExpression[computed=true][property.value="desktopBridge"], VariableDeclarator[init.name=/^(?:window|globalThis)$/] > ObjectPattern > Property[key.name="desktopBridge"])',
  message:
    "Mechanical gate 1 in `apps/desktop/AGENTS.md`: renderer code reaches the bridge only through `services/platform/live-bridge.ts`, and every surface above it takes the bridge from the platform bridge provider's context. A second reader is a second idea of when the bridge exists and what stands in for it under test.",
};

/**
 * `export default`, which this package uses for root tool configuration and nothing else.
 *
 * A default export has no name at the import site, so two importers can call one symbol two things
 * and a rename reaches neither. The tools that load a config by default export
 * (`*.config.{ts,mjs}`, `.dependency-cruiser.mjs`) live at the package root, outside every scope
 * this rule is composed into.
 *
 * Both spellings are banned: `export { x as default }` (and its `… from "./other.js"` form) parses
 * as an `ExportSpecifier`, not an `ExportDefaultDeclaration`, and publishes the same nameless
 * symbol. `export { default as Thing } from …` is untouched: it imports a default and republishes
 * it under a name, which is the remedy.
 */
const EXPORT_DEFAULT_DECLARATION = {
  selector: ':matches(ExportDefaultDeclaration, ExportSpecifier[exported.name="default"])',
  message:
    "Mechanical gate 3 in `apps/desktop/AGENTS.md`: named exports only. `export default` is for tool configuration at the package root — `*.config.{ts,mjs}` and `.dependency-cruiser.mjs`, which their tools load by default export — and nowhere else: a default export has no name at the import site, so two importers can call one symbol two things and a rename reaches neither.",
};

/**
 * A module-level `let`, which is a singleton every importer in the window shares.
 *
 * Scoped to the shipped renderer surface: a suite's module-level `let` reassigned in `beforeEach`
 * is the standard vitest shape and holds no shared runtime state, so the unions composed for
 * `*.test.*` and `*.test-support.*` drop this selector.
 *
 * The exported form is banned too and is the strongest spelling of the hazard: `export let` parses
 * as `Program > ExportNamedDeclaration > VariableDeclaration`, so a bare child combinator would
 * miss it, yet every importer observes the live binding. A `let` nested in a module-level block is
 * left alone, and `no-var` covers module-level `var`.
 */
const MODULE_LEVEL_LET = {
  selector: ':matches(Program, ExportNamedDeclaration) > VariableDeclaration[kind="let"]',
  message:
    "Mechanical gate 4 in `apps/desktop/AGENTS.md`: stateful logic is an encapsulated class with private fields. A module-level `let` is a singleton every importer in the window shares and any of them can reassign — put it in a class, a hook, or a controller the caller constructs.",
};

/**
 * Reaching `child_process` dynamically. The static forms are `no-restricted-imports`' half of the
 * same claim; these two are the spellings that rule cannot see. `spawnSync` is untouched: it
 * settles before the next statement, so it leaves nothing behind for a test to own.
 */
const CHILD_PROCESS_DYNAMIC_REACH = [
  {
    selector: "ImportExpression[source.value=/child_process/]",
    message:
      "Mechanical gate 5 in `apps/desktop/AGENTS.md`: `tests/helpers/electron-child.ts` is the only module that reaches `spawn` from `node:child_process`, and it registers the kill on `onTestFinished` so a spawned child's lifetime belongs to the test rather than to a timer. Spawn through that module; `spawnSync` is untouched.",
  },
  {
    selector: 'CallExpression[callee.name="require"][arguments.0.value=/child_process/]',
    message:
      "Mechanical gate 5 in `apps/desktop/AGENTS.md`: `tests/helpers/electron-child.ts` is the only module that reaches `spawn` from `node:child_process`, and it registers the kill on `onTestFinished` so a spawned child's lifetime belongs to the test rather than to a timer. Spawn through that module; `spawnSync` is untouched.",
  },
];

const WINDOW_CLASS_NAME = "/^(BrowserWindow|BaseWindow|WebContentsView)$/";

/**
 * A window or web view built outside the window factory. The factory holds the one locked
 * `webPreferences` block, so a construction anywhere else ships a window that block does not
 * govern.
 */
const WINDOW_CONSTRUCTION_OUTSIDE_FACTORY = {
  selector: `NewExpression:matches([callee.name=${WINDOW_CLASS_NAME}], [callee.property.name=${WINDOW_CLASS_NAME}])`,
  message:
    "Every window and web view is built by the window factory in `src/main/windows/window.ts`, which holds the one locked `webPreferences` block. Build it there.",
};

const HARDENED_WHEN_TRUE = "/^(contextIsolation|sandbox|webSecurity)$/";
const HARDENED_WHEN_FALSE = "/^(nodeIntegration|nodeIntegrationInWorker)$/";

/**
 * A window security setting written as anything but its hardened literal: `sandbox: false`, and
 * also `sandbox: someFlag`, whose value no reader of the source can vouch for.
 */
const WEAKENED_WINDOW_SETTING = [
  {
    selector: `Property:matches([key.name=${HARDENED_WHEN_TRUE}], [key.value=${HARDENED_WHEN_TRUE}]):not([value.raw="true"])`,
    message:
      "`contextIsolation`, `sandbox` and `webSecurity` are written as the literal `true` in the main process. A window with any of them off runs the renderer with more reach than the hardening allows.",
  },
  {
    selector: `Property:matches([key.name=${HARDENED_WHEN_FALSE}], [key.value=${HARDENED_WHEN_FALSE}]):not([value.raw="false"])`,
    message:
      "`nodeIntegration` and `nodeIntegrationInWorker` are written as the literal `false` in the main process. Either one on hands Node to the renderer.",
  },
];

/**
 * A text snapshot in a package whose Vitest runs resolve `UPDATE_SNAPSHOT=all`.
 *
 * `vitest/screenshot-pins.ts` sets that variable so the screenshot tier writes its capture aids
 * instead of gating on them, and it is process-wide because Vitest offers no per-project snapshot
 * mode. Under it a text snapshot rewrites itself and passes, the one shape of green that means
 * nothing. No such matcher exists in this package today; this keeps it that way. Assert the value
 * instead.
 *
 * Scope is every directory this package's `lint` script reads: `src/**`, `tests/**`, `fixtures/**`,
 * `scripts/**`, `build/**` and `vitest/**`. Most of `main-unit`'s `include` entries live outside
 * the renderer and `tests/**` unions, so a narrower ban would leave the process-wide mode unguarded
 * in the projects that run under it. Because flat config replaces a rule's options at the last
 * matching block, the selector is added to each block by name rather than declared once in a widest
 * one.
 */
const TEXT_SNAPSHOT_MATCHER_REACH = {
  selector:
    "MemberExpression[property.name=/^toMatch(Inline|File)?Snapshot$/], MemberExpression[computed=true][property.value=/^toMatch(Inline|File)?Snapshot$/]",
  message:
    "Mechanical gate 9 in `apps/desktop/AGENTS.md`: this package's Vitest runs resolve `UPDATE_SNAPSHOT=all` so the screenshot tier writes capture aids rather than gating on them, and under that mode a text snapshot rewrites itself instead of failing. Assert the value.",
};

/**
 * Writing a capture anywhere but through the settled capture.
 *
 * A capture taken straight after a mount photographs the reserved region a loader-backed body has
 * not filled yet, a picture of a pane that had not finished loading. `captureSettled` refuses a
 * tree still carrying the pending marker, so every written capture goes through it. A never-saved
 * `page.screenshot({ save: false })` read is a measurement, not a capture, and is outside this
 * rule, which names the matcher.
 */
const SCREENSHOT_MATCHER_REACH = {
  // The computed arm is the same reach with the matcher named as a string —
  // `expect(page)["toMatchScreenshot"]()` — which the property-name arm cannot see.
  selector:
    ':matches(MemberExpression[property.name="toMatchScreenshot"], MemberExpression[computed=true][property.value="toMatchScreenshot"])',
  message:
    "Mechanical gate 6 in `apps/desktop/AGENTS.md`: a screenshot is taken through `tests/screenshot/settled-capture.ts` and no other way. A capture taken straight after a mount photographs the region a loader-backed body has not filled yet — stable, green, and a picture of a pane that had not finished loading.",
};

/**
 * A stylesheet imported from another folder.
 *
 * A component imports its own sheet from its own folder, so importing the component brings its
 * styles. Relative and `@renderer/` specifiers only: a vendor sheet reached by package specifier
 * has no owning folder here.
 *
 * A trailing query is still the sheet: `./x.css?inline` and `./x.css?raw` are bundler spellings of
 * the same import, so the match is not `$`-anchored. The dynamic form carries the sheet as the
 * static one does (the chunk it lands on is the component's), so both declarations are named.
 */
const STYLESHEET_SPECIFIER = "^(?:[.][.]?[/]|@renderer[/]).*[.]css(?:[?].*)?$";
const SAME_FOLDER_STYLESHEET_SPECIFIER = "^[.][/][^/?]+[.]css(?:[?].*)?$";
const STYLESHEET_OUTSIDE_FOLDER_SPECIFIER = `[source.value=/${STYLESHEET_SPECIFIER}/]:not([source.value=/${SAME_FOLDER_STYLESHEET_SPECIFIER}/])`;

const STYLESHEET_THROUGH_OWNER = {
  selector: `:matches(ImportDeclaration${STYLESHEET_OUTSIDE_FOLDER_SPECIFIER}, ImportExpression${STYLESHEET_OUTSIDE_FOLDER_SPECIFIER})`,
  message:
    "Mechanical gate 7 in `apps/desktop/AGENTS.md`: a component imports its own sheet from its own folder (`X.tsx` imports `./X.css`); a sheet that styles several components of a feature is imported by the feature's top view or its lazily-loaded chunk root (`*-body.ts`); a global sheet in `styles/` is imported by `main.tsx`. A module that reaches into another folder's sheet puts that surface's rules wherever the module loads.",
};

/**
 * A directory `import.meta.glob` under `src/`.
 *
 * The literal must carry a `*`: a raw read of one named module differs from a walk that decides its
 * own membership. A walk under `src/` is a second source of truth for what the tree holds and is
 * silently wrong when a file moves.
 *
 * The array arm covers the multi-pattern spelling, `import.meta.glob(["./views/*.ts"])`, where the
 * literal is a grandchild of the call rather than its direct child.
 */
const DIRECTORY_SOURCE_GLOB = {
  selector:
    ':matches(CallExpression[callee.object.type="MetaProperty"][callee.property.name="glob"] > Literal[value=/[*]/], CallExpression[callee.object.type="MetaProperty"][callee.property.name="glob"] > ArrayExpression > Literal[value=/[*]/])',
  message:
    "A directory `import.meta.glob` under `src/` is a second source of truth for what the tree holds, and it decides its own membership — so it is silently wrong the moment a file moves and reports nothing. Name the modules, or let the bundler's own entry graph decide.",
};

/**
 * The syntax bans every shipped renderer file carries.
 *
 * Composed rather than repeated: flat config replaces a rule's options at the last matching config
 * object, so a file matched by two blocks carries only the later one's selectors. Each block below
 * states the whole union for its files, and a block that lifts one selector states the union minus
 * that selector rather than turning the rule off.
 */
const RENDERER_SYNTAX_BANS = [
  ENUM_DECLARATION,
  EXPORT_DEFAULT_DECLARATION,
  DIRECTORY_SOURCE_GLOB,
  MODULE_LEVEL_LET,
  STYLESHEET_THROUGH_OWNER,
  // Carried by the renderer union, not a test-file block: a separate block matching `**/*.test.tsx`
  // would sit after these and lift every other selector for those files. Riding the union puts the
  // ban on co-located tests, where a snapshot would be written.
  TEXT_SNAPSHOT_MATCHER_REACH,
  // A surface that reads the bridge off the global with no existence check throws
  // inside a render under a preload that failed to install.
  BRIDGE_GLOBAL_READ,
  ...TIME_READING_SELECTORS,
  EXPORTED_COLLECTION_SELECTOR,
];

/** What every test file carries. */
const TEST_SYNTAX_BANS = [
  ENUM_DECLARATION,
  EXPORT_DEFAULT_DECLARATION,
  SCREENSHOT_MATCHER_REACH,
  TEXT_SNAPSHOT_MATCHER_REACH,
  ...CHILD_PROCESS_DYNAMIC_REACH,
];

/**
 * The test tiers, which read the same wire stamps the renderer does. The exported-collection ban
 * applies for the same reason as in the renderer union: a tier module that publishes a `Set`
 * publishes one object every suite in the project shares, and a suite that grows it changes what a
 * later suite measures.
 */
const TIER_SYNTAX_BANS = [
  ...TEST_SYNTAX_BANS,
  ...TIME_READING_SELECTORS,
  EXPORTED_COLLECTION_SELECTOR,
];

/** What every main-process file carries. */
const MAIN_SYNTAX_BANS = [
  ENUM_DECLARATION,
  EXPORT_DEFAULT_DECLARATION,
  DIRECTORY_SOURCE_GLOB,
  TEXT_SNAPSHOT_MATCHER_REACH,
  ...CHILD_PROCESS_DYNAMIC_REACH,
  WINDOW_CONSTRUCTION_OUTSIDE_FACTORY,
  ...WEAKENED_WINDOW_SETTING,
];

/**
 * A union minus the selectors one file class is excused from, matched by identity so a lifted entry
 * cannot stop being lifted when its selector is reworded, nor lift a second entry that reads the
 * same.
 */
function withoutSelectors(bans, ...liftedBans) {
  return bans.filter((ban) => !liftedBans.includes(ban));
}

/**
 * The files that may import a sheet from another folder: a lazily-loaded chunk root. `main.tsx`
 * joins them where this is used, for the global sheets.
 */
const STYLESHEET_OWNER_FILES = ["**/*-body.{ts,tsx}"];

/** Suites and their scaffolding, which are not shipped and hold no shared runtime state. */
const RENDERER_TEST_FILES = ["**/*.test.{ts,tsx}", "**/*.test-support.{ts,tsx}"];

/** `files` globs, rooted at a renderer subtree. */
function rendererFiles(subtree, patterns) {
  return patterns.map((pattern) => `src/renderer/src/${subtree}/${pattern}`);
}

/**
 * The file sections mechanical gate 10 in `AGENTS.md` names, in declaration-kind order: exported
 * types and interfaces (the module's contract), then the exported class or function the file is
 * named for, then everything private.
 *
 * Only the exported forms are ranked. A non-exported declaration matches no listed group and
 * becomes `unknown`, one bucket held last and left unsorted, which keeps the module-shape exception
 * (a private type that exactly one helper uses may sit directly above that helper) followable.
 * Verified against `eslint-plugin-perfectionist` 5.12.1: it emits `export-function` and `function`
 * for an exported declaration and only `function` for a private one, and ranks an unmatched group
 * last.
 *
 * Module-level constants are convention only: `sort-modules` has no variable selector, and it
 * starts a fresh partition after every `VariableDeclaration`, so the rule neither positions a
 * constant nor moves a declaration across one.
 */
const MODULE_SECTION_GROUPS = [
  ["export-type", "export-interface"],
  "export-class",
  "export-function",
  "unknown",
];

/**
 * Mechanical gate 11 in `AGENTS.md`, the order inside a class: fields, constructor, public methods,
 * private methods. Accessors rank with the methods of their own accessibility (this tree writes
 * `get` after the constructor), and `protected` ranks with `private`, since the split is the
 * externally reachable surface against everything else. An absent accessibility modifier reads as
 * `public` and a `#`-hash member as `private`, so both match this tree's style without an explicit
 * keyword.
 */
const CLASS_SECTION_GROUPS = [
  ["index-signature", "static-block", "property", "accessor-property", "function-property"],
  "constructor",
  ["public-method", "public-get-method", "public-set-method"],
  [
    "protected-method",
    "protected-get-method",
    "protected-set-method",
    "private-method",
    "private-get-method",
    "private-set-method",
  ],
  "unknown",
];

const desktopConfig = defineConfig(
  root,
  // `src/shared/**` is imported by both processes, so all of it is bundled into the renderer. The
  // renderer ban below is scoped to `src/renderer/src/**`, so without this block a `node:fs` import
  // could reach the renderer bundle through a shared module and pass lint. It restates the
  // shipped-renderer ban with no test carve-out: a shared test file is not bundled either way, and
  // a shared module has no reason to touch a Node builtin.
  {
    files: ["src/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message:
                "`src/shared/**` is bundled into the RENDERER: `electron` must never be imported here. Put main-process code in `src/main/**` and share only data and pure functions.",
            },
            {
              name: "@ai-sidekicks/runtime-daemon",
              message:
                "`src/shared/**` is bundled into the renderer: the daemon package must never be imported here. Route through the preload bridge.",
            },
            {
              name: "@ai-sidekicks/control-plane",
              message:
                "`src/shared/**` is bundled into the renderer: the control-plane package must never be imported here. Route through the preload bridge.",
            },
          ],
          patterns: [
            {
              group: ["electron/**"],
              message:
                "`src/shared/**` is bundled into the renderer: `electron` and every `electron/*` subpath are forbidden here.",
            },
            {
              group: ["node:**"],
              message:
                "`src/shared/**` is bundled into the renderer: `node:*` protocol imports (and their subpaths) are forbidden here.",
            },
            {
              group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
              message:
                "Daemon / control-plane subpaths are forbidden in `src/shared/**`, which is bundled into the renderer.",
            },
            {
              group: ["**/main/**", "**/preload/**", "@main/**", "@preload/**"],
              message:
                "`src/shared/**` is bundled into the renderer: it must never reach into `main/**` or `preload/**`. Dependencies point the other way: main imports shared, never the reverse.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: RENDERER_RESTRICTED_PATHS, patterns: RENDERER_RESTRICTED_PATTERNS },
      ],
    },
  },
  // The renderer outside `services/`: the renderer ban plus `zod` and the schemas
  // `@ai-sidekicks/contracts` already ships.
  //
  // Every daemon reply the renderer reads is parsed in one module,
  // `services/daemon/daemon-reply.ts`, against the schemas
  // `services/daemon/daemon-reply-registry.ts` binds to each method. A surface that could reach the
  // validator directly could parse a second time, differently, or skip the parse and keep the
  // fulfilled `unknown`. A surface needing a shape asks for the method, not for a schema.
  //
  // Banning `zod` alone left the second parser one import away: the contracts package publicly
  // exports the schema objects the registry composes, so a surface could call `.safeParse()` on a
  // reply it obtained directly. The ban is therefore on the name as well as the package: a renderer
  // module outside `services/**` may import types and non-schema values from contracts
  // (`SESSION_EVENT_CATEGORY_BY_TYPE`, `createStubBridge`, `ARTIFACT_CHUNK_MAX_BYTES`) and no
  // binding whose name ends in `Schema`.
  //
  // The import is banned, not the call: `.parse(` is not a zod name
  // (`registries/commands/when-clause/when-clause-parser.ts` calls `.parse()` on its own parser and
  // two time suites call `Date.parse`), so a call selector's findings would be mostly false.
  // `.safeParse(` needs no ban once the import is banned, because a schema can only arrive by
  // importing `zod`, importing this package, or through a renderer barrel that re-exported one, and
  // both import spellings refuse here.
  //
  // `services/**` is exempt as a layer, not the chokepoint file alone: the registry composes
  // contracts-exported schemas, the run-stream projector decodes a subscription payload, and the
  // scenario contract checks assert against the wire's own shapes, three modules in one layer below
  // every surface.
  //
  // It restates the renderer ban because flat config replaces a rule's options at the last matching
  // object, and spreads the hoisted arrays so the two cannot drift.
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    ignores: ["src/renderer/src/services/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: RENDERER_RESTRICTED_PATHS,
          patterns: RENDERER_WIRE_RESTRICTED_PATTERNS,
        },
      ],
    },
  },
  // A test may parse through a contracts schema to build or check contract-shaped data;
  // it still takes no `zod` of its own.
  {
    files: rendererFiles("**", RENDERER_TEST_FILES),
    ignores: ["src/renderer/src/services/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: RENDERER_RESTRICTED_PATHS,
          patterns: [...RENDERER_RESTRICTED_PATTERNS, ZOD_IMPORT],
        },
      ],
    },
  },
  // `zod` where a module owns the data it validates, never a contracts schema. The schema
  // form validates a person's answers against a workflow's input schema, which is not a
  // wire read.
  {
    files: ["src/renderer/src/features/workflows/schema-form/json-schema-validator.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: RENDERER_RESTRICTED_PATHS,
          patterns: [...RENDERER_RESTRICTED_PATTERNS, CONTRACTS_SCHEMA_IMPORT],
        },
      ],
    },
  },
  // A contracts schema and no `zod` of its own: the approval fold reads each approval
  // event's payload through that event's contract schema, because the stream decoder
  // passes payloads through unexamined and a half-read ask would draw a card for an
  // action nobody can see. The store may not import `services/`, so the read sits here.
  {
    files: ["src/renderer/src/store/session-events/approval-flow-projection.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: RENDERER_RESTRICTED_PATHS,
          patterns: [...RENDERER_RESTRICTED_PATTERNS, ZOD_IMPORT],
        },
      ],
    },
  },
  // --- Syntax bans, one union per file class -----------------------------------
  //
  // Every block below states the whole union for its files, because flat config replaces a rule's
  // options at the last matching object. The order is widest-first: a later block is either a
  // narrower subtree that adds selectors, or a file class that lifts one and restates the rest.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ENUM_DECLARATION,
        EXPORT_DEFAULT_DECLARATION,
        DIRECTORY_SOURCE_GLOB,
        TEXT_SNAPSHOT_MATCHER_REACH,
      ],
    },
  },
  {
    // The main process spawns for real (the daemon supervisor and the PTY sidecar) through its own
    // supervised lifetimes, not the test spawner, so it carries the dynamic-reach pair beside the
    // import ban below, and the window-security bans, which main alone can break.
    files: ["src/main/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...MAIN_SYNTAX_BANS] },
  },
  {
    // The window factory is where windows are built; its settings stay held to their literals.
    files: ["src/main/windows/window.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(MAIN_SYNTAX_BANS, WINDOW_CONSTRUCTION_OUTSIDE_FACTORY),
      ],
    },
  },
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...RENDERER_SYNTAX_BANS] },
  },
  {
    // A chunk root imports the feature-wide sheets its body needs, and `main.tsx` the
    // global ones in `styles/`.
    files: [...rendererFiles("**", STYLESHEET_OWNER_FILES), "src/renderer/src/main.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(RENDERER_SYNTAX_BANS, STYLESHEET_THROUGH_OWNER),
      ],
    },
  },
  {
    // Suites and their scaffolding. A module-level `let` reassigned in `beforeEach` is the standard
    // vitest shape and holds no state anything else can reach, so that ban is lifted and every
    // other selector restated. The bridge-global ban comes off because a renderer suite installs a
    // fixture bridge on the global and deletes it in `afterEach`; that is the substitution seam the
    // ban protects, not a second reader.
    files: rendererFiles("**", RENDERER_TEST_FILES),
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(RENDERER_SYNTAX_BANS, MODULE_LEVEL_LET, BRIDGE_GLOBAL_READ),
      ],
    },
  },
  {
    // The time-ban negative controls, which have to CALL the banned API to
    // demonstrate what it answers. Everything else the renderer carries stays on.
    files: TIME_READING_EXEMPT_FILES,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(
          RENDERER_SYNTAX_BANS,
          MODULE_LEVEL_LET,
          BRIDGE_GLOBAL_READ,
          ...TIME_READING_SELECTORS,
        ),
      ],
    },
  },
  {
    // The one renderer module that may read the bridge off the window. The platform bridge provider
    // calls into it and hands the result down as context, so every surface takes the bridge from
    // here and the ban is lifted only here.
    files: ["src/renderer/src/services/platform/live-bridge.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(RENDERER_SYNTAX_BANS, BRIDGE_GLOBAL_READ),
      ],
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}", "fixtures/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...TIER_SYNTAX_BANS] },
  },
  {
    // The process-table reader parses the start stamp `ps` prints for a process. That is
    // the operating system's clock, read in the host's zone on purpose, not a wire
    // instant, so the time-reading bans do not apply to it.
    files: ["tests/helpers/process-tree/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(TIER_SYNTAX_BANS, ...TIME_READING_SELECTORS),
      ],
    },
  },
  {
    // The capture module itself, and nothing else.
    files: ["tests/screenshot/settled-capture.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(TIER_SYNTAX_BANS, SCREENSHOT_MATCHER_REACH),
      ],
    },
  },
  {
    // The spawn module. It registers the kill on `onTestFinished`, which runs on a pass,
    // on a failure, and on vitest's own timeout kill alike.
    files: ["tests/helpers/electron-child.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(TIER_SYNTAX_BANS, ...CHILD_PROCESS_DYNAMIC_REACH),
      ],
    },
  },
  {
    files: ["scripts/**/*.{ts,mts}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ENUM_DECLARATION,
        EXPORT_DEFAULT_DECLARATION,
        TEXT_SNAPSHOT_MATCHER_REACH,
        ...CHILD_PROCESS_DYNAMIC_REACH,
      ],
    },
  },
  {
    files: ["build/**/*.{ts,mts}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ENUM_DECLARATION,
        EXPORT_DEFAULT_DECLARATION,
        TEXT_SNAPSHOT_MATCHER_REACH,
      ],
    },
  },
  {
    // The modules `vitest.config.ts` composes, which set the process-wide snapshot mode. The
    // config itself sits at the package root, so no file here has a reason to default-export.
    files: ["vitest/**/*.{ts,mts}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ENUM_DECLARATION,
        EXPORT_DEFAULT_DECLARATION,
        TEXT_SNAPSHOT_MATCHER_REACH,
      ],
    },
  },
  {
    // A declaration file carries no runtime code — no call, no assignment, no import of
    // a stylesheet — so every selector above is unreachable in one, and the `export
    // default` inside an ambient `declare module` is how a virtual module that DOES
    // default-export is typed (`~icons/*` in `vite-env.d.ts`).
    files: ["**/*.d.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  // --- The refresh cadence: no wall-clock polling in the renderer ----------------
  //
  // Every refresh goes through `lib/reads/refresh-scheduler.ts`. A `setInterval` beside it is a
  // second cadence that nothing cancels on unmount, pauses when the window is hidden, or bounds
  // when the daemon stops answering. Both spellings are banned, since `window.setInterval` and the
  // bare global are the same timer.
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "setInterval",
          message:
            "Mechanical gate 2 in `apps/desktop/AGENTS.md`: every refresh goes through `lib/reads/refresh-scheduler.ts`. A `setInterval` is a second cadence nothing cancels on unmount, nothing pauses when the window is hidden, and nothing bounds when the daemon stops answering.",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "window",
          property: "setInterval",
          message:
            "Mechanical gate 2 in `apps/desktop/AGENTS.md`: every refresh goes through `lib/reads/refresh-scheduler.ts`. A `setInterval` is a second cadence nothing cancels on unmount, nothing pauses when the window is hidden, and nothing bounds when the daemon stops answering.",
        },
        {
          object: "globalThis",
          property: "setInterval",
          message:
            "Mechanical gate 2 in `apps/desktop/AGENTS.md`: every refresh goes through `lib/reads/refresh-scheduler.ts`. A `setInterval` is a second cadence nothing cancels on unmount, nothing pauses when the window is hidden, and nothing bounds when the daemon stops answering.",
        },
      ],
    },
  },
  // --- The spawn module, as an import ban ---------------------------------------
  //
  // The static half of the claim `CHILD_PROCESS_DYNAMIC_REACH` makes about `import()` and
  // `require`. Both specifier spellings are named, since `no-restricted-imports` treats
  // `child_process` and `node:child_process` as distinct. `spawnSync` is absent because it settles
  // before the next statement and leaves no child for a test to own.
  {
    files: ["tests/**/*.{ts,tsx}", "src/main/**/*.ts", "scripts/**/*.{ts,mts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["spawn"],
              message:
                "Mechanical gate 5 in `apps/desktop/AGENTS.md`: `tests/helpers/electron-child.ts` is the only module that reaches `spawn`, and it registers the kill on `onTestFinished` — which runs on a pass, on a failure, and on vitest's own timeout kill alike. A child a timer was going to kill is reparented to init when the worker is torn down first. `spawnSync` is untouched.",
            },
            {
              name: "child_process",
              importNames: ["spawn"],
              message:
                "Mechanical gate 5 in `apps/desktop/AGENTS.md`: `tests/helpers/electron-child.ts` is the only module that reaches `spawn`, and it registers the kill on `onTestFinished`. The prefix-less specifier resolves to the same builtin. `spawnSync` is untouched.",
            },
          ],
        },
      ],
    },
  },
  {
    // The spawn module itself.
    files: ["tests/helpers/electron-child.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  // --- Member order: the file and class shapes of mechanical gates 10 and 11 in `AGENTS.md` ---
  //
  // Scope is the renderer source, `src/renderer/src/**/*.{ts,tsx}`, co-located tests included.
  //
  // Both rules run `type: "unsorted"`: the claim is the order of the sections, never an alphabet.
  // Within a section source order is preserved, so a file whose sections are already right reports
  // nothing and a reorder is pure movement. That relies on the plugin defaults for
  // `newlinesBetween` (`"ignore"`), `partitionByComment` and `partitionByNewLine` (both `false`),
  // none of which is set here.
  //
  // The structure-enforcement axis admits two libraries: `eslint-plugin-perfectionist`, with no
  // rule beyond these two enabled, and `eslint-plugin-check-file`, which the root config applies
  // to file and folder names. `@typescript-eslint/member-ordering` is not used.
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    plugins: { perfectionist },
    rules: {
      "perfectionist/sort-modules": ["error", { type: "unsorted", groups: MODULE_SECTION_GROUPS }],
      "perfectionist/sort-classes": ["error", { type: "unsorted", groups: CLASS_SECTION_GROUPS }],
    },
  },
);

export default requireJsxInTsx(desktopConfig);
