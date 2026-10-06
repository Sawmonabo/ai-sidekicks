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
// and `export *` bans (which every block below that sets `no-restricted-syntax` restates). It
// inherits no `no-restricted-imports`: the root's blocks are path-scoped to `packages/`, so every
// import restriction that applies here is declared below in full.
//
// Flat-config resolution: for a file, ESLint applies the last config object whose `files` match,
// and an object that supplies rule options replaces the earlier options wholesale, with no deep
// merge and no union of `paths` or `patterns`. Each block below is therefore self-contained. The
// wire-parsing block restates the renderer ban by spreading the arrays hoisted below rather than
// copying them, so a ban added to the renderer list reaches it too.
import {
  BRIDGE_GLOBAL_READ,
  CHILD_PROCESS_DYNAMIC_REACH,
  DIRECTORY_SOURCE_GLOB,
  EXPORTED_COLLECTION_SELECTOR,
  EXPORT_DEFAULT_DECLARATION,
  MODULE_LEVEL_LET,
  SCREENSHOT_MATCHER_REACH,
  STYLESHEET_THROUGH_OWNER,
  TEXT_SNAPSHOT_MATCHER_REACH,
  TIME_READING_EXEMPT_FILES,
  TIME_READING_SELECTORS,
  WEAKENED_WINDOW_SETTING,
  WINDOW_CONSTRUCTION_OUTSIDE_FACTORY,
} from "./eslint.restricted-syntax.mjs";
import { defineConfig } from "eslint/config";
import perfectionist from "eslint-plugin-perfectionist";
import root, {
  ENUM_DECLARATION,
  EXPORT_ALL_DECLARATION,
  requireJsxInTsx,
} from "../../eslint.config.mjs";

/**
 * The bare specifiers renderer source may not import. Hoisted so the wire-parsing block can extend
 * the list instead of restating it: flat config replaces a rule's options at the last matching
 * object, so a shorter list there would silently delete every entry it forgot.
 */
const RENDERER_RESTRICTED_PATHS = [
  {
    name: "electron",
    message:
      "The renderer is untrusted: `electron` must NEVER be imported from " +
      "renderer source. Route through the preload bridge " +
      "(`window.desktopBridge`) instead. See apps/desktop/src/preload/index.ts.",
  },
  {
    name: "fs",
    message:
      "The renderer is untrusted: Node built-in `fs` is forbidden " +
      "in renderer source. Route through the preload bridge.",
  },
  {
    name: "child_process",
    message:
      "The renderer is untrusted: Node built-in `child_process` is " +
      "forbidden in renderer source. Route through the preload bridge.",
  },
  {
    name: "net",
    message:
      "The renderer is untrusted: Node built-in `net` is forbidden " +
      "in renderer source. Route through the preload bridge.",
  },
  {
    name: "os",
    message:
      "The renderer is untrusted: Node built-in `os` is forbidden " +
      "in renderer source. Route through the preload bridge.",
  },
  {
    name: "path",
    message:
      "The renderer is untrusted: Node built-in `path` is forbidden " +
      "in renderer source. Route through the preload bridge.",
  },
  {
    name: "process",
    message:
      "The renderer is untrusted: Node built-in `process` is " +
      "forbidden in renderer source. Route through the preload bridge.",
  },
  {
    name: "@ai-sidekicks/runtime-daemon",
    message:
      "The renderer is untrusted: the daemon package must NEVER be " +
      "imported from renderer source (directly or through a local helper). " +
      "Route through the preload bridge (`window.desktopBridge.daemon`).",
  },
  {
    name: "@ai-sidekicks/control-plane",
    message:
      "The renderer is untrusted: the control-plane package must NEVER be imported " +
      "from renderer source (directly or through a local helper). The control " +
      "plane is reached through the background service, never from renderer source.",
  },
];

/** Why renderer source may not import main or preload code, however the specifier reaches it. */
const RENDERER_INTO_MAIN_OR_PRELOAD =
  "The renderer is untrusted: imports into `main/**` or `preload/**`, " +
  "relative or through `#main` / `#preload`, are forbidden. The renderer's " +
  "only cross-process surface is the `window.desktopBridge` bridge.";

/** Why `src/shared/**` may not import main or preload code. */
const SHARED_INTO_MAIN_OR_PRELOAD =
  "`src/shared/**` is bundled into the renderer: it must never " +
  "reach into `main/**` or `preload/**`. Dependencies point " +
  "the other way: main imports shared, never the reverse.";

/** The specifier GROUPS renderer source may not import. Hoisted for the same reason. */
const RENDERER_RESTRICTED_PATTERNS = [
  {
    // Electron subpath entrypoints (`electron/renderer`, `electron/main`, and any nested subpath).
    // `no-restricted-imports` treats a bare specifier and its subpaths as distinct, so the `paths`
    // entry for `electron` does not cover them. `**` matches across slashes (gitignore-style), so
    // this catches every present and future subpath.
    group: ["electron/**"],
    message:
      "The renderer is untrusted: `electron` (and any `electron/*` subpath) must " +
      "NEVER be imported from renderer source. Route through the preload bridge " +
      "(`window.desktopBridge`) instead. See apps/desktop/src/preload/index.ts.",
  },
  {
    // The rule treats `fs` and `node:fs` as distinct specifiers, so `paths` bans the bare forms and
    // this glob bans every `node:*` specifier and its subpaths (`node:fs`, `node:fs/promises`,
    // `node:stream/web`).
    group: ["node:**"],
    message:
      "The renderer is untrusted: `node:*` protocol imports (and their subpaths, e.g. " +
      "`node:fs/promises`) are forbidden in renderer source. Route through the preload bridge.",
  },
  {
    // Subpaths of the two banned workspace packages, which the `paths` entries do not cover
    // (`@ai-sidekicks/control-plane/router`). Same `**` semantics as the `electron/**` group.
    group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
    message:
      "The renderer is untrusted: daemon / control-plane package subpaths are forbidden " +
      "in renderer source. Route through the preload bridge (`window.desktopBridge`).",
  },
  {
    // Escape into the main and preload subtrees by a relative path (`../main/x`). `**` matches
    // zero or more path segments, so any depth is caught. The only legitimate cross-process
    // channel is `window.desktopBridge`.
    group: ["**/main/**", "**/preload/**"],
    message: RENDERER_INTO_MAIN_OR_PRELOAD,
  },
  {
    // The same escape through the package's `#main/*` and `#preload/*` imports. A regex, because
    // `group` takes gitignore syntax, where a leading `#` starts a comment.
    regex: "^#(?:main|preload)/",
    message: RENDERER_INTO_MAIN_OR_PRELOAD,
  },
  {
    // Three or more `../` segments, at any depth.
    regex: "^(?:\\.\\./){3}",
    message:
      "No deep relative import (`../../../`). Use the package import for the folder it reaches " +
      "(`#renderer/`, `#shared/`, `#fixtures/`); an import inside a module stays `./`.",
  },
];

/** The `zod` library, which a surface never needs to parse a wire value. */
const ZOD_IMPORT = {
  // Bare specifier and every subpath (`zod/v4`, `zod/mini`) in one group, since the rule treats
  // them as distinct.
  group: ["zod", "zod/**"],
  message:
    "A surface never parses a wire value itself. Reach the daemon through " +
    "`callDaemon` from `services/daemon/reply.ts`, which parses the reply " +
    "against the method's registered schema and answers `served` or `refused`; a " +
    "value that needs a shape needs a registry row, not a local validator.",
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
    "A surface never parses a wire value itself, and a contracts schema is a parser. " +
    "Reach the daemon through `callDaemon` from `services/daemon/reply.ts`, " +
    "which parses the reply against the method's registered schema and answers `served` " +
    "or `refused`; a value that needs a shape needs a registry row, not a second " +
    "reading of one. Types and non-schema values from this package are untouched.",
};

/** The daemon method table, which hands out each method's schemas: the same claim again. */
const DAEMON_METHOD_BINDINGS_IMPORT = {
  // A regex, because `group` takes gitignore syntax, where a leading `#` starts a comment.
  regex: "^#shared/daemon/method-bindings\\.js$",
  message:
    "The daemon method table binds each method to its schemas, which are parsers. " +
    "Reach the daemon through `callDaemon` from `services/daemon/reply.ts`.",
};

/**
 * The groups a renderer module outside `services/` may not import: the renderer's, plus
 * the three that keep wire parsing out of a surface. Flat config replaces a rule's options
 * at the last matching block, so each narrower block below spreads these instead of
 * copying them.
 */
const RENDERER_WIRE_RESTRICTED_PATTERNS = [
  ...RENDERER_RESTRICTED_PATTERNS,
  ZOD_IMPORT,
  CONTRACTS_SCHEMA_IMPORT,
  DAEMON_METHOD_BINDINGS_IMPORT,
];

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
  EXPORT_ALL_DECLARATION,
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
  EXPORT_ALL_DECLARATION,
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
  EXPORT_ALL_DECLARATION,
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
 * The files that may import a sheet from another folder: the chunk roots whose sheet styles
 * components in several folders, and `main.tsx` for the global sheets.
 */
const STYLESHEET_OWNER_FILES = [
  "src/renderer/src/features/agents/pane/body.ts",
  "src/renderer/src/features/transcript/contributions/pane-body.ts",
  "src/renderer/src/main.tsx",
];

/** Suites and their scaffolding, which are not shipped and hold no shared runtime state. */
const RENDERER_TEST_FILES = ["**/*.test.{ts,tsx}", "**/*.test-support.{ts,tsx}"];

/** `files` globs, rooted at a renderer subtree. */
function rendererFiles(subtree, patterns) {
  return patterns.map((pattern) => `src/renderer/src/${subtree}/${pattern}`);
}

/**
 * The file sections mechanical gate 10 in `apps/desktop/AGENTS.md` names, in declaration-kind
 * order: exported types and interfaces (the module's contract), then the exported class or function
 * the file is named for, then everything private.
 *
 * Only the exported forms are ranked. A non-exported declaration matches no listed group and
 * becomes `unknown`, one bucket held last and left unsorted, which keeps gate 10's exception (a
 * private type that exactly one helper uses may sit directly above that helper) followable.
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
 * Mechanical gate 11 in `apps/desktop/AGENTS.md`, the order inside a class: fields, constructor,
 * public methods, private methods. Accessors rank with the methods of their own accessibility
 * (this tree writes `get` after the constructor), and `protected` ranks with `private`, since the
 * split is the externally reachable surface against everything else. An absent accessibility
 * modifier reads as `public` and a `#`-hash member as `private`, so both match this tree's style
 * without an explicit keyword.
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

/** The bare `setInterval` global; the refresh cadence block below bans its qualified spellings. */
const SET_INTERVAL_GLOBAL = {
  name: "setInterval",
  message:
    "Mechanical gate 2 in `apps/desktop/AGENTS.md`: every refresh goes " +
    "through `lib/reads/refresh/scheduler.ts`. A `setInterval` is a " +
    "second cadence nothing cancels on unmount, nothing pauses when the " +
    "window is hidden, and nothing bounds when the daemon stops answering.",
};

/** The fixture build flag, read only by `app/App.tsx`, which chooses the fixture composition. */
const FIXTURE_BUILD_FLAG_GLOBAL = {
  name: "__FIXTURE_BUILD__",
  message:
    "Only `app/App.tsx` reads `__FIXTURE_BUILD__`: it chooses the fixture " +
    "composition once, at startup. Take the fixture implementation from " +
    "that composition instead of branching on the flag.",
};

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
                "`src/shared/**` is bundled into the RENDERER: `electron` " +
                "must never be imported here. Put main-process code in " +
                "`src/main/**` and share only data and pure functions.",
            },
            {
              name: "@ai-sidekicks/runtime-daemon",
              message:
                "`src/shared/**` is bundled into the renderer: the daemon package " +
                "must never be imported here. Route through the preload bridge.",
            },
            {
              name: "@ai-sidekicks/control-plane",
              message:
                "`src/shared/**` is bundled into the renderer: the control-plane " +
                "package must never be imported here. Route through the preload bridge.",
            },
          ],
          patterns: [
            {
              group: ["electron/**"],
              message:
                "`src/shared/**` is bundled into the renderer: `electron` " +
                "and every `electron/*` subpath are forbidden here.",
            },
            {
              group: ["node:**"],
              message:
                "`src/shared/**` is bundled into the renderer: `node:*` " +
                "protocol imports (and their subpaths) are forbidden here.",
            },
            {
              group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
              message:
                "Daemon / control-plane subpaths are forbidden in " +
                "`src/shared/**`, which is bundled into the renderer.",
            },
            {
              group: ["**/main/**", "**/preload/**"],
              message: SHARED_INTO_MAIN_OR_PRELOAD,
            },
            {
              // A regex, because `group` takes gitignore syntax, where a leading `#` starts a
              // comment.
              regex: "^#(?:main|preload)/",
              message: SHARED_INTO_MAIN_OR_PRELOAD,
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
  // `services/daemon/reply.ts`, against the schemas
  // `src/shared/daemon/method-bindings.ts` binds to each method. A surface that could reach
  // the validator directly could parse a second time, differently, or skip the parse and keep the
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
  // (`registries/commands/when-clause/parser.ts` calls `.parse()` on its own parser and
  // two time suites call `Date.parse`), so a call selector's findings would be mostly false.
  // `.safeParse(` needs no ban once the import is banned, because a schema can only arrive by
  // importing `zod`, importing this package, or through a renderer barrel that re-exported one, and
  // both import spellings refuse here.
  //
  // `services/**` is exempt as a layer, not the chokepoint file alone: `callDaemon` reads the
  // daemon method table, the run-stream projector decodes a subscription payload, and the scenario
  // contract checks assert against the wire's own shapes, three modules in one layer below every
  // surface. The table itself sits in `src/shared/`, because main's relay parses against it too,
  // so it is banned here by its module name.
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
  // A contracts schema and no `zod` of its own: the approval fold reads each approval
  // event's payload through that event's contract schema, because the stream decoder
  // passes payloads through unexamined and a half-read ask would draw a card for an
  // action nobody can see. The store may not import `services/`, so the read sits here.
  {
    files: ["src/renderer/src/store/session/events/approval-flow-projection.ts"],
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
        EXPORT_ALL_DECLARATION,
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
    files: ["src/main/windows/factory.ts"],
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
    files: STYLESHEET_OWNER_FILES,
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
    // The spawn module. It registers the kill on `onTestFinished`, which runs on a pass,
    // on a failure, and on vitest's own timeout kill alike.
    files: ["tests/helpers/electron/child/child.ts"],
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
        EXPORT_ALL_DECLARATION,
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
        EXPORT_ALL_DECLARATION,
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
        EXPORT_ALL_DECLARATION,
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
  // Every refresh goes through `lib/reads/refresh/scheduler.ts`. A `setInterval` beside it
  // is a second cadence that nothing cancels on unmount, pauses when the window is hidden, or
  // bounds when the daemon stops answering. Both spellings are banned, since `window.setInterval`
  // and the bare global are the same timer. The fixture build flag rides the same globals list.
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": ["error", SET_INTERVAL_GLOBAL, FIXTURE_BUILD_FLAG_GLOBAL],
      "no-restricted-properties": [
        "error",
        {
          object: "window",
          property: "setInterval",
          message:
            "Mechanical gate 2 in `apps/desktop/AGENTS.md`: every refresh goes " +
            "through `lib/reads/refresh/scheduler.ts`. A `setInterval` is a " +
            "second cadence nothing cancels on unmount, nothing pauses when the " +
            "window is hidden, and nothing bounds when the daemon stops answering.",
        },
        {
          object: "globalThis",
          property: "setInterval",
          message:
            "Mechanical gate 2 in `apps/desktop/AGENTS.md`: every refresh goes " +
            "through `lib/reads/refresh/scheduler.ts`. A `setInterval` is a " +
            "second cadence nothing cancels on unmount, nothing pauses when the " +
            "window is hidden, and nothing bounds when the daemon stops answering.",
        },
      ],
    },
  },
  // The app's entry reads the fixture build flag to choose the fixture composition once.
  {
    files: ["src/renderer/src/app/App.tsx"],
    rules: { "no-restricted-globals": ["error", SET_INTERVAL_GLOBAL] },
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
                "Mechanical gate 5 in `apps/desktop/AGENTS.md`: " +
                "`tests/helpers/electron/child/child.ts` is the only module that reaches " +
                "`spawn`, and it registers the kill on `onTestFinished` — which " +
                "runs on a pass, on a failure, and on vitest's own timeout kill " +
                "alike. A child a timer was going to kill is reparented to init " +
                "when the worker is torn down first. `spawnSync` is untouched.",
            },
            {
              name: "child_process",
              importNames: ["spawn"],
              message:
                "Mechanical gate 5 in `apps/desktop/AGENTS.md`: " +
                "`tests/helpers/electron/child/child.ts` is the only module that reaches " +
                "`spawn`, and it registers the kill on `onTestFinished`. The prefix-less " +
                "specifier resolves to the same builtin. `spawnSync` is untouched.",
            },
          ],
        },
      ],
    },
  },
  {
    // The spawn module itself.
    files: ["tests/helpers/electron/child/child.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Main's one start of the background service. Its child is meant to outlive the app, so it
    // starts detached and released; no test or app lifetime owns it, and the supervisor reaches
    // it only through its socket. A test that starts it kills it by process id in teardown.
    files: ["src/main/services/daemon/service/start.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  // --- Member order: file and class shapes, mechanical gates 10 and 11 in `apps/desktop/AGENTS.md`
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
