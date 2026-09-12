// Package-scoped ESLint flat-config for `@ai-sidekicks/desktop`.
//
// Purpose: enforce the renderer-untrusted boundary at the import surface. The
// renderer process is the untrusted surface;
// every Node / Electron / main-process / preload-process capability MUST
// reach the renderer ONLY via the `window.sidekicks` bridge declared by
// `apps/desktop/src/preload/index.ts`. This config makes that boundary
// structurally unbypassable: any direct import of Node/Electron APIs (or any
// relative-path escape into `src/main/**` or `src/preload/**`) from renderer
// source fails `pnpm --filter @ai-sidekicks/desktop lint`. A reviewer or
// future contributor cannot silently introduce such an import without CI
// turning red.
//
// The ban applies to `src/renderer/src/**/*.{ts,tsx}` AND to
// `src/shared/**/*.{ts,tsx}` — the main and preload processes legitimately
// depend on `electron`, `node:*`, and friends, and must remain free to import
// them, but a shared module is bundled into the renderer and so carries exactly
// the renderer's constraints. Scope is narrowed by the `files` selectors on the
// override blocks below.
//
// Tier-1 ban list (this task): `electron`, the `node:*` protocol family,
// the bare-specifier Node built-ins (`fs`, `child_process`, `net`, `os`,
// `path`, `process`), and relative-path escapes into `**/main/**` /
// `**/preload/**`. The extended ban list (`keytar`, `@napi-rs/keyring`,
// `@sentry/electron`) lands when those modules do; banning them before they
// exist in the workspace would be inert.
//
// The two server-side workspace packages, `@ai-sidekicks/runtime-daemon` and
// `@ai-sidekicks/control-plane`, are banned here too. The renderer must reach
// both ONLY through the bridge, and a per-component source scan cannot see a
// violation reached through a local helper (component → `./helper.js` →
// `@ai-sidekicks/control-plane` scans clean). Lint traverses every renderer
// file, so it catches the transitive shape such a scan structurally cannot.
// It is asserted against the REAL rule — not a reimplementation — by
// `src/renderer/src/runtime-node-attach/__tests__/renderer-import-boundary.test.ts`.
//
// This config spreads the repo-root `eslint.config.mjs` first, so this package
// inherits its `@eslint/js` recommended baseline, `typescript-eslint`
// recommended, the repo-wide `ignores`, and the shared `languageOptions`. It
// inherits NO `no-restricted-imports`: the root's two blocks are path-scoped to
// files under `packages/control-plane/src/sessions/` and `packages/contracts/src/`,
// so neither selector matches a file in this app (verified against the resolved
// config — for a renderer file the root's `pg` entry and its Buffer
// `no-restricted-globals` entry are both absent). Every import restriction that
// applies here is declared below, in full.
//
// Flat-config resolution, since the two blocks below configure the same rule:
// for a given file ESLint applies the LAST config object in the array whose
// `files` match, and an object that supplies rule OPTIONS replaces the earlier
// options wholesale — no deep merge, no union of `paths` / `patterns`. A
// `files` selector decides only WHETHER an object matches; its narrowness or
// breadth has no bearing on how options combine, and there is no such thing as
// a "merge conflict" between two selectors. Each block below is therefore
// self-contained by necessity. The replace-not-merge semantics are pinned
// against the real engine by `renderer-import-boundary.test.ts` ("a later
// config object's rule options replace, never merge").
//
// The console/shell block below is the one place a file IS matched by two
// `no-restricted-imports` objects, and it is written knowing that: it restates the
// renderer ban by SPREADING the two arrays hoisted directly beneath this comment
// rather than by copying them, so the replace-not-merge semantics above cost the
// console nothing and a ban added to the renderer list reaches the console with it.
// The one thing that block adds is `zod` — see its own comment.
import {
  CONSOLE_TIME_READING_EXEMPT_FILES,
  CONSOLE_TIME_READING_SELECTORS,
  EXPORTED_COLLECTION_SELECTOR,
} from "./eslint.console-syntax-bans.mjs";
import perfectionist from "eslint-plugin-perfectionist";
import root from "../../eslint.config.mjs";

/**
 * The bare specifiers renderer source may not import. Hoisted so the console/shell
 * block can extend the list instead of restating it: flat config REPLACES a rule's
 * options at the last matching object, so a second block that spelled out its own
 * shorter list would silently delete every entry it forgot.
 */
const RENDERER_RESTRICTED_PATHS = [
  {
    name: "electron",
    message:
      "The renderer is untrusted: `electron` must NEVER be imported from renderer source. Route through the preload bridge (`window.sidekicks`) instead. See apps/desktop/src/preload/index.ts.",
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
      "The renderer is untrusted: the daemon package must NEVER be imported from renderer source (directly or through a local helper). Route through the preload bridge (`window.sidekicks.daemon`).",
  },
  {
    name: "@ai-sidekicks/control-plane",
    message:
      "The renderer is untrusted: the control-plane package must NEVER be imported from renderer source (directly or through a local helper). Route through the preload bridge (`window.sidekicks.controlPlane`).",
  },
];

/** The specifier GROUPS renderer source may not import. Hoisted for the same reason. */
const RENDERER_RESTRICTED_PATTERNS = [
  {
    // Electron subpath entrypoints (`electron/renderer`, `electron/main`,
    // `electron/common`, and any nested subpath) sit alongside the bare
    // `electron` specifier banned in `paths` above. `no-restricted-imports`
    // treats bare specifiers and subpaths as distinct, so the
    // `paths: "electron"` entry does NOT cover `electron/renderer` et al. The
    // `**` glob uses gitignore-style semantics (via the `ignore` package) and
    // matches across slashes, so this catches every documented and future
    // Electron subpath at once.
    group: ["electron/**"],
    message:
      "The renderer is untrusted: `electron` (and any `electron/*` subpath) must NEVER be imported from renderer source. Route through the preload bridge (`window.sidekicks`) instead. See apps/desktop/src/preload/index.ts.",
  },
  {
    // `no-restricted-imports` does NOT auto-cover `node:fs` from a `fs` ban
    // (nor vice versa) — the rule treats `fs` and `node:fs` as distinct
    // specifiers. We list both: `paths` for the bare forms above, and this
    // glob for the entire `node:*` protocol family AND its subpaths. `**`
    // matches across slashes (gitignore-style) so this single pattern catches
    // both leaf imports (`node:fs`, `node:os`) and subpath imports
    // (`node:fs/promises`, `node:stream/web`, `node:dns/promises`,
    // `node:readline/promises`, `node:stream/consumers`).
    group: ["node:**"],
    message:
      "The renderer is untrusted: `node:*` protocol imports (and their subpaths, e.g. `node:fs/promises`) are forbidden in renderer source. Route through the preload bridge.",
  },
  {
    // Subpath entrypoints of the two banned workspace packages.
    // `no-restricted-imports` treats a bare specifier and its subpaths as
    // distinct, so the `paths` entries above do NOT cover
    // `@ai-sidekicks/control-plane/router` et al. Same gitignore-style `**`
    // semantics as the `electron/**` group.
    group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
    message:
      "The renderer is untrusted: daemon / control-plane package subpaths are forbidden in renderer source. Route through the preload bridge (`window.sidekicks`).",
  },
  {
    // Relative-path escape into the main/preload subtrees. `**` matches
    // zero-or-more path segments so this catches any depth: `../main/x`,
    // `../../main/x`, `../../../main/x`, etc., and the same for `preload`. The
    // renderer-untrusted boundary means renderer source must NEVER reach into
    // another process's source — the only legitimate channel is the
    // preload-exposed `window.sidekicks` bridge.
    group: ["**/main/**", "**/preload/**"],
    message:
      "The renderer is untrusted: relative-path imports into `main/**` or `preload/**` are forbidden. The renderer's only cross-process surface is the `window.sidekicks` bridge.",
  },
];

/**
 * The groups a console or shell module may not import: the renderer's, plus the two
 * that keep wire parsing out of a surface.
 *
 * Hoisted because flat config replaces a rule's options at the LAST matching config
 * object, so any narrower block below that names a console file would have to restate
 * this whole union — and a union spread from one const cannot drift from the block it
 * was copied out of. One block spends it today; the hoist stays because the hazard is
 * the rule's, not that block's, and a second narrower block is one edit away.
 */
const CONSOLE_RESTRICTED_PATTERNS = [
  ...RENDERER_RESTRICTED_PATTERNS,
  {
    // Bare specifier and every subpath (`zod/v4`, `zod/mini`) in one
    // group: `no-restricted-imports` treats them as distinct, and a ban
    // on the bare form alone would be one import away from useless.
    group: ["zod", "zod/**"],
    message:
      "A console surface never parses a wire value itself. Reach the daemon through `callDaemon` from `console/bridge/`, which parses the reply against the method's registered schema and answers `served` or `refused`; a value that needs a shape needs a registry row, not a local validator.",
  },
  {
    // The same claim as the `zod` group above, on the schemas the corpus
    // has already built. It is a `patterns` entry rather than a `paths`
    // one because that is where the rule's schema puts `importNamePattern`
    // — measured against the installed engine, whose `paths` items admit
    // only `importNames` — and an exhaustive `importNames` list would go
    // stale the day the contracts package exports its next schema.
    group: ["@ai-sidekicks/contracts"],
    // Every schema the reply registry composes ends this way, and so does
    // every other schema the package exports: the suffix is how this
    // corpus spells a parser, not a guess about one.
    importNamePattern: "Schema$",
    message:
      "A console surface never parses a wire value itself, and a contracts schema is a parser. Reach the daemon through `callDaemon` from `console/bridge/`, which parses the reply against the method's registered schema and answers `served` or `refused`; a value that needs a shape needs a registry row, not a second reading of one. Types and non-schema values from this package are untouched.",
  },
];

/**
 * Reading the preload bridge off the window.
 *
 * `console/bridge/live-bridge.ts` is the one console module that may — `BridgeProvider`
 * calls its `readInstalledBridge` and hands the result down as context, so the provider
 * is where the bridge is DISTRIBUTED and the live bridge is where it is READ. A second
 * reader is a second idea of when the bridge exists, what it does before it does, and
 * which fixture stands in for it under test.
 *
 * Five arms, because one spelling of the read is one identifier away from useless:
 * `window.sidekicks`, `globalThis.sidekicks`, and the cast form a typed reach needs —
 * `(window as { sidekicks?: SidekicksBridge }).sidekicks`, whose object is a
 * `TSAsExpression` rather than an identifier, so the first three arms walk straight past
 * it. The cast arm keys on the cast alone rather than on what it wraps: a nested
 * `as unknown as` is a second `TSAsExpression`, and any `(x as T).sidekicks` at all is
 * a bridge reach whatever `x` is.
 *
 * The last two are the spellings the first three were measured to walk past. A COMPUTED
 * key — `globalThis["sidekicks"]` — is the same read with the property written as a
 * string, and it is keyed on the property alone rather than on the object, because a
 * computed `.sidekicks` off anything at all is a bridge reach. A DESTRUCTURE —
 * `const { sidekicks } = window;` — performs no member read at all: it names the global
 * as an initialiser and takes the binding straight off it.
 *
 * ONE SPELLING IS NOT CLOSABLE BY A SELECTOR and is stated in `apps/desktop/AGENTS.md`
 * beside the rule instead: an ALIAS — `const w = window; w.sidekicks` — needs the
 * selector to know what `w` holds, which esquery cannot answer.
 */
const BRIDGE_GLOBAL_READ = {
  selector:
    ':matches(MemberExpression[object.name="window"][property.name="sidekicks"], MemberExpression[object.name="globalThis"][property.name="sidekicks"], MemberExpression[object.type="TSAsExpression"][property.name="sidekicks"], MemberExpression[computed=true][property.value="sidekicks"], VariableDeclarator[init.name=/^(?:window|globalThis)$/] > ObjectPattern > Property[key.name="sidekicks"])',
  message:
    "The import-boundary rules in `apps/desktop/AGENTS.md`: renderer code reaches the bridge only through `console/bridge/live-bridge.ts`, and every surface above it takes the bridge from `BridgeProvider`'s context. A second reader is a second idea of when the bridge exists and what stands in for it under test.",
};

/**
 * `export default`, which this package uses for root tool configuration and nothing else.
 *
 * A default export has no name at the import site, so two importers can call one symbol
 * two things and a rename reaches neither. The tools that load a config by default export
 * — `*.config.{ts,mjs}` and `.dependency-cruiser.mjs` — live at the package root, which is
 * outside every scope this rule is composed into.
 *
 * BOTH SPELLINGS. `export { x as default }` — and its `… from "./other.js"` re-export
 * form — parses as an `ExportSpecifier` and not an `ExportDefaultDeclaration`, so the
 * first arm walks past it while it publishes exactly the nameless symbol this ban is
 * about. `export { default as Thing } from …` is untouched: that one IMPORTS a default
 * and republishes it under a name, which is the remedy rather than the defect.
 */
const EXPORT_DEFAULT_DECLARATION = {
  selector: ':matches(ExportDefaultDeclaration, ExportSpecifier[exported.name="default"])',
  message:
    "The module-shape rules in `apps/desktop/AGENTS.md`: named exports only. `export default` is for tool configuration at the package root — `*.config.{ts,mjs}` and `.dependency-cruiser.mjs`, which their tools load by default export — and nowhere else: a default export has no name at the import site, so two importers can call one symbol two things and a rename reaches neither.",
};

/**
 * A module-level `let`, which is a singleton every importer in the window shares.
 *
 * Scoped to the SHIPPED renderer surface. A suite's module-level `let` reassigned in
 * `beforeEach` is the standard vitest shape and holds no shared runtime state, so the
 * unions composed for `*.test.*` and `*.test-support.*` drop this selector rather than
 * exempting a growing list of files.
 *
 * THE EXPORTED FORM TOO, which is the strongest spelling of the hazard rather than an
 * edge of it: `export let` parses as `Program > ExportNamedDeclaration >
 * VariableDeclaration`, so a bare child combinator walks straight past the one spelling
 * where every importer also observes the live binding directly. A `let` nested inside a
 * module-level block is left alone — it is not a realistic accident, and `no-var`
 * already covers the module-level `var`.
 */
const MODULE_LEVEL_LET = {
  selector: ':matches(Program, ExportNamedDeclaration) > VariableDeclaration[kind="let"]',
  message:
    "The state-and-views rules in `apps/desktop/AGENTS.md`: stateful logic is an encapsulated class with private fields. A module-level `let` is a singleton every importer in the window shares and any of them can reassign — put it in a class, a hook, or a controller the caller constructs.",
};

/**
 * Reaching `child_process` dynamically.
 *
 * The static forms are `no-restricted-imports`' half of the same claim; these two are the
 * spellings that rule cannot see. `spawnSync` is deliberately untouched — it settles
 * before the statement after it, so it leaves nothing behind for a test to own.
 */
const CHILD_PROCESS_DYNAMIC_REACH = [
  {
    selector: "ImportExpression[source.value=/child_process/]",
    message:
      "The test rules in `apps/desktop/AGENTS.md`: `test/helpers/electron-child.ts` is the only module that reaches `spawn` from `node:child_process`, and it registers the kill on `onTestFinished` so a spawned child's lifetime belongs to the test rather than to a timer. Spawn through that door; `spawnSync` is untouched.",
  },
  {
    selector: 'CallExpression[callee.name="require"][arguments.0.value=/child_process/]',
    message:
      "The test rules in `apps/desktop/AGENTS.md`: `test/helpers/electron-child.ts` is the only module that reaches `spawn` from `node:child_process`, and it registers the kill on `onTestFinished` so a spawned child's lifetime belongs to the test rather than to a timer. Spawn through that door; `spawnSync` is untouched.",
  },
];

/**
 * A text snapshot in a package whose Vitest runs resolve `UPDATE_SNAPSHOT=all`.
 *
 * `vitest/screenshot-pins.ts` sets that variable so the screenshot tier writes its
 * capture aids instead of gating on them, and the variable is process-wide because
 * Vitest offers no per-project snapshot mode. Under it a text snapshot does not fail
 * on a change — it rewrites itself and passes, which is the one shape of green that
 * means nothing. There is no such matcher in this package today; this is what keeps
 * it that way. Assert the value instead.
 *
 * SCOPE: every directory this package's `lint` script reads — `src/**` (the renderer
 * union and, through the widest `src` block, `src/main/**`, `src/preload/**`, and
 * `src/shared/**`), `test/**`, `scripts/**`, `build/**`, and `vitest/**`. That set is
 * not decoration: five of `main-unit`'s six `include` entries live outside the renderer
 * and `test/**` unions, so a ban that stopped there would leave the process-wide mode
 * unguarded in exactly the projects that run under it. Because flat config REPLACES a
 * rule's options at the last matching block, the selector is added to each block by
 * name rather than declared once in a widest one, which a later block would drop.
 */
const TEXT_SNAPSHOT_MATCHER_REACH = {
  selector:
    "MemberExpression[property.name=/^toMatch(Inline|File)?Snapshot$/], MemberExpression[computed=true][property.value=/^toMatch(Inline|File)?Snapshot$/]",
  message:
    "The test rules in `apps/desktop/AGENTS.md`: this package's Vitest runs resolve `UPDATE_SNAPSHOT=all` so the screenshot tier writes capture aids rather than gating on them, and under that mode a text snapshot rewrites itself instead of failing. Assert the value.",
};

/**
 * Writing a capture anywhere but through the settled capture.
 *
 * A capture taken straight after a mount photographs the reserved region a loader-backed
 * body has not filled yet — a picture of a pane that had not finished loading, which is
 * exactly what a person opening `__screenshots__/` must not be shown. `captureSettled`
 * refuses a tree still carrying the pending marker, which is why every written capture
 * goes through it. A never-saved `page.screenshot({ save: false })` read is a
 * MEASUREMENT rather than a capture and is outside this rule, which names the matcher.
 */
const SCREENSHOT_MATCHER_REACH = {
  // The computed arm is the same reach with the matcher named as a string —
  // `expect(page)["toMatchScreenshot"]()` — which the property-name arm cannot see.
  selector:
    ':matches(MemberExpression[property.name="toMatchScreenshot"], MemberExpression[computed=true][property.value="toMatchScreenshot"])',
  message:
    "The test rules in `apps/desktop/AGENTS.md`: a screenshot is taken through `test/console/screenshot/settled-capture.ts` and no other way. A capture taken straight after a mount photographs the region a loader-backed body has not filled yet — stable, green, and a picture of a pane that had not finished loading.",
};

/**
 * A stylesheet entering through a component rather than through its directory's door.
 *
 * Relative specifiers only: the rule is about the sheets this tree owns, and a vendor
 * sheet reached by package specifier has no owning directory here to enter through.
 *
 * A TRAILING QUERY IS STILL THE SHEET. `./x.css?inline` and `./x.css?raw` are bundler
 * spellings of the same import, and an `$`-anchored `.css` match walks straight past
 * them. And the DYNAMIC form carries the sheet exactly as the static one does — the
 * chunk it lands on is the chunk the component is on — so both declarations are named.
 */
const RELATIVE_STYLESHEET_SPECIFIER = "^[.][.]?[/].*[.]css(?:[?].*)?$";

const STYLESHEET_THROUGH_OWNER = {
  selector: `:matches(ImportDeclaration[source.value=/${RELATIVE_STYLESHEET_SPECIFIER}/], ImportExpression[source.value=/${RELATIVE_STYLESHEET_SPECIFIER}/])`,
  message:
    "The module-shape rules in `apps/desktop/AGENTS.md`: a stylesheet enters through the barrel of the directory that OWNS it — that directory's `index.ts`, or the root of the chunk a lazily-loaded body arrives on (`*-body.ts`) — and through no component. A component that pulls a sheet in puts that surface's rules on the initial document for every session that never opens it.",
};

/**
 * A directory `import.meta.glob` under `src/`.
 *
 * The literal has to carry a `*`: a raw read of ONE named module is a different act from
 * a walk that decides its own membership. A walk under `src/` is a second source of truth
 * for what the tree holds, and it is silently wrong the moment a file moves.
 *
 * The array arm is the multi-pattern spelling the API also accepts —
 * `import.meta.glob(["./views/*.ts"])` — where the literal is a grandchild of the call
 * rather than its direct child, so the first arm walks past it.
 */
const DIRECTORY_SOURCE_GLOB = {
  selector:
    ':matches(CallExpression[callee.object.type="MetaProperty"][callee.property.name="glob"] > Literal[value=/[*]/], CallExpression[callee.object.type="MetaProperty"][callee.property.name="glob"] > ArrayExpression > Literal[value=/[*]/])',
  message:
    "A directory `import.meta.glob` under `src/` is a second source of truth for what the tree holds, and it decides its own membership — so it is silently wrong the moment a file moves and reports nothing. Name the modules, or let the bundler's own entry graph decide.",
};

/**
 * The syntax bans every SHIPPED renderer file carries.
 *
 * Composed rather than repeated, for the reason the header states about
 * `no-restricted-imports` and which is true of every rule: flat config replaces a rule's
 * options at the LAST matching config object, so a file matched by two blocks carries
 * only the later one's selectors. Each block below therefore states the whole union for
 * the files it names, and a block that LIFTS one selector states the union minus that
 * selector rather than turning the rule off.
 */
const RENDERER_SYNTAX_BANS = [
  EXPORT_DEFAULT_DECLARATION,
  DIRECTORY_SOURCE_GLOB,
  MODULE_LEVEL_LET,
  STYLESHEET_THROUGH_OWNER,
  // Carried by the renderer union rather than by a test-file block of its own, because
  // flat config REPLACES a rule's options at the last matching entry: a separate block
  // matching `**/*.test.tsx` would sit after these and lift every other selector for
  // exactly the files that already carry them. Riding the union puts the ban on the
  // renderer's co-located tests, which is where a snapshot would actually be written.
  TEXT_SNAPSHOT_MATCHER_REACH,
  // Renderer-wide rather than console-scoped, because the hazard is the renderer's and
  // not the console's: a surface that reads the bridge off the global with no existence
  // check throws inside a render under a preload that failed to install. Two legacy
  // modules outside `console/` do read it that way today; they are exempted BY NAME in
  // their own block below, so the count is frozen and a third cannot land unnoticed.
  BRIDGE_GLOBAL_READ,
];

/** The same, plus what only the console and the shell subtree it composes seats for carry. */
const CONSOLE_SYNTAX_BANS = [
  ...RENDERER_SYNTAX_BANS,
  ...CONSOLE_TIME_READING_SELECTORS,
  EXPORTED_COLLECTION_SELECTOR,
];

/** What every file under `test/` carries. */
const TEST_SYNTAX_BANS = [
  EXPORT_DEFAULT_DECLARATION,
  SCREENSHOT_MATCHER_REACH,
  TEXT_SNAPSHOT_MATCHER_REACH,
  ...CHILD_PROCESS_DYNAMIC_REACH,
];

/**
 * The console tiers, which read the same wire stamps the console does.
 *
 * The exported-collection ban is here for the same reason it is in the console union: a
 * tier module that publishes a `Set` publishes one object every suite in the project
 * shares, and a suite that grows it changes what a later suite measures.
 */
const CONSOLE_TIER_SYNTAX_BANS = [
  ...TEST_SYNTAX_BANS,
  ...CONSOLE_TIME_READING_SELECTORS,
  EXPORTED_COLLECTION_SELECTOR,
];

/**
 * A union minus the selectors one file class is excused from, matched by IDENTITY.
 *
 * By identity rather than by selector text so a lifted entry cannot silently stop being
 * lifted when its selector is reworded, and cannot silently lift a second entry that
 * happens to read the same.
 */
function withoutSelectors(bans, ...liftedBans) {
  return bans.filter((ban) => !liftedBans.includes(ban));
}

/** The stylesheet owners: a directory's own door, and the root of a lazily-loaded chunk. */
const STYLESHEET_OWNER_FILES = ["**/index.ts", "**/*-body.{ts,tsx}"];

/** Suites and their scaffolding, which are not shipped and hold no shared runtime state. */
const RENDERER_TEST_FILES = ["**/*.test.{ts,tsx}", "**/*.test-support.{ts,tsx}"];

/** `files` globs, rooted at a renderer subtree. */
function rendererFiles(subtree, patterns) {
  return patterns.map((pattern) => `src/renderer/src/${subtree}/${pattern}`);
}

/**
 * The file sections `AGENTS.md` names under Module shape, in declaration-kind order: the
 * exported types and interfaces that are the module's contract, then the exported class
 * or function the file is named for, then everything private.
 *
 * Only the EXPORTED forms are ranked. A non-exported declaration matches no listed group
 * and so becomes `unknown` — one bucket, held last and left `unsorted`, which is what
 * keeps the module-shape exception ("a private type that exactly one helper uses may sit
 * directly above that helper") followable: the type and its helper are both in it, so
 * their relative order is never touched. Verified against the shipped 5.11.0 rule —
 * `generate-predefined-groups.js` emits `export-function` AND `function` for an exported
 * declaration and only `function` for a private one, and `get-group-index.js` ranks an
 * unmatched group last.
 *
 * Module-level constants (module-shape section 4) are convention only: `sort-modules`
 * has no variable selector, and `compute-node-details.js` starts a fresh PARTITION after
 * every `VariableDeclaration`, so the rule neither positions a constant nor moves any
 * declaration across one.
 */
const CONSOLE_MODULE_GROUPS = [
  ["export-type", "export-interface"],
  "export-class",
  "export-function",
  "unknown",
];

/**
 * The `AGENTS.md` module-shape rule inside a class: fields, constructor, public methods, private
 * methods. Accessors rank with the methods of their own accessibility — this tree already
 * writes `get` after the constructor — and `protected` ranks with `private`, since the
 * split the four sections draw is the externally reachable surface against everything
 * else. An accessibility modifier that is absent reads as `public` and a `#`-hash member
 * reads as `private` (`node-info/common-modifiers.js`), so both halves match on this
 * tree's own style without an explicit keyword.
 */
const CONSOLE_CLASS_GROUPS = [
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

export default [
  ...root,
  // `src/shared/**` is imported by BOTH processes (see
  // `src/shared/auxiliary-routes.ts`), which means every byte of it is bundled
  // into the RENDERER. The renderer-untrusted ban below is scoped to
  // `src/renderer/src/**`, so without this block a `node:fs` import could reach
  // the renderer bundle through a shared module and pass lint — the same
  // transitive shape that block's package bans exist to close, arriving through
  // a different door. The ban restated here is the shipped-renderer one;
  // there is no test carve-out, because a shared test file is not bundled either
  // way and a shared module has no reason to touch a Node builtin at all.
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
              group: ["**/main/**", "**/preload/**"],
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
    // Scope is the SHIPPED renderer surface. `__tests__/**` is excluded here
    // and re-covered by the narrower block below, mirroring the repo-root
    // `packages/contracts` isomorphism block, which excludes its own tests for
    // the same reason: the ban exists to keep Node/Electron capability out of
    // the renderer BUNDLE, and test files are never bundled — they run under
    // vitest, where a Node builtin is legitimate (this package's own
    // `renderer-import-boundary.test.ts` lints the tree via the ESLint Node
    // API and so must import `node:path`). The renderer-untrusted guarantee
    // for shipped code is unaffected: every non-test renderer file is still
    // matched by this block.
    ignores: ["src/renderer/src/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: RENDERER_RESTRICTED_PATHS, patterns: RENDERER_RESTRICTED_PATTERNS },
      ],
    },
  },
  // The CONSOLE and the shell subtree it composes seats for. One entry more than
  // the renderer block above, and one subtree less.
  //
  // WHAT IT ADDS. `zod`, AND THE SCHEMAS `@ai-sidekicks/contracts` ALREADY SHIPS.
  // Every daemon reply the console reads is parsed at one door —
  // `console/bridge/daemon/daemon-reply.ts`, against the schemas
  // `console/bridge/daemon/daemon-reply-registry.ts` binds to each method — and a surface
  // that could reach the validator directly could parse a second time, differently,
  // or skip the parse and keep the fulfilled `unknown`. That is not hypothetical:
  // the per-family parsers this chokepoint replaces were three different readings
  // of one seam, and one of them did no parsing at all. A surface needing a shape
  // asks for the method, not for a schema.
  //
  // BANNING `zod` ALONE LEFT THE SECOND PARSER ONE IMPORT AWAY. The contracts
  // package publicly exports the ready-made schema objects the registry composes,
  // and the console is otherwise free to import that package — so a surface could
  // take `QueueItemListResponseSchema`, call `.safeParse()` on a reply it obtained
  // directly, and be exactly the per-surface parser this gate claims to reject,
  // with no lint error anywhere. The ban is therefore on the NAME as well as on the
  // package: a console module outside `bridge/**` may import types and non-schema
  // values from contracts (`SESSION_EVENT_CATEGORY_BY_TYPE`, `createTier1Bridge`,
  // `MAIN_CHANNEL_NAME`) and no binding whose name ends in `Schema`.
  //
  // WHY THE IMPORT AND NOT THE CALL. A `.parse(` / `.safeParse(` selector was the
  // other candidate and is measurably worse in both directions. `.parse(` is not a
  // zod name: `console/palette/when-clause/when-clause-parser.ts` calls `.parse()` on its own
  // parser and the two exempt time suites call `Date.parse`, so the selector's
  // first three findings in this tree would be false — a ban whose false alarms
  // outnumber its findings is a ban somebody turns off. And `.safeParse(` needs no
  // banning once the import is banned: a schema can only ARRIVE by importing `zod`
  // (banned above), by importing this package (banned here), or through a console
  // barrel that re-exported one — and no console barrel does, which this ban is what
  // keeps true: a barrel can only re-export a schema it imported, and both spellings
  // of that import refuse here.
  //
  // WHY `console/bridge/**` IS EXEMPT RATHER THAN THE CHOKEPOINT FILE ALONE. The
  // registry composes contracts-exported schemas, the run-stream projector decodes
  // a subscription payload, and the wire-truth scenarios assert against the wire's
  // own shapes — three modules in one family, all of them below every surface. The
  // family is the honest unit: a file-scoped exemption would have to grow a line
  // per module and would say nothing about which layer may hold a validator.
  //
  // WHY IT RESTATES THE RENDERER BAN. Flat config replaces a rule's options at the
  // last matching object, so this block must carry every entry that block carries
  // or the console silently loses the renderer-untrusted boundary. It SPREADS the
  // hoisted arrays rather than copying them, so the two cannot drift.
  //
  // WHY IT SITS HERE AND NOT LAST. The `__tests__` block below must keep winning
  // for the files it names, exactly as it does today. Nothing under `console/`
  // carries a `__tests__` directory — the package's own structure rules put a
  // console test beside its module — so this ordering changes no file's verdict
  // and leaves that block's asymmetry to say what it already says.
  {
    files: ["src/renderer/src/console/**/*.{ts,tsx}", "src/renderer/src/shell/**/*.{ts,tsx}"],
    ignores: ["src/renderer/src/console/bridge/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: RENDERER_RESTRICTED_PATHS,
          patterns: CONSOLE_RESTRICTED_PATTERNS,
        },
      ],
    },
  },
  // Renderer TEST files: the Node/Electron builtin ban above is deliberately
  // lifted (they are not bundled — see that block's comment), but the
  // workspace-package boundary is NOT. No renderer test has any
  // reason to import the daemon or control-plane package, and leaving the
  // exclusion total would hand test files a hole in the very boundary the
  // sibling `renderer-import-boundary.test.ts` exists to enforce. This block
  // RESTATES those two entries rather than inheriting them, because
  // nothing is inherited: the block above `ignores` `__tests__/**` and so does
  // not match these files at all, and even where two objects did both match,
  // the later one's options would replace the earlier one's wholesale (see the
  // header note on flat-config resolution). Drop either entry from this block
  // and that half of the boundary silently disappears for test files.
  {
    files: ["src/renderer/src/**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@ai-sidekicks/runtime-daemon",
              message:
                "The daemon package is forbidden in renderer source, tests included — assert against the bridge contract (`@ai-sidekicks/contracts`) instead.",
            },
            {
              name: "@ai-sidekicks/control-plane",
              message:
                "The control-plane package is forbidden in renderer source, tests included — assert against the bridge contract (`@ai-sidekicks/contracts`) instead.",
            },
          ],
          patterns: [
            {
              group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
              message:
                "Daemon / control-plane subpaths are forbidden in renderer source, tests included.",
            },
          ],
        },
      ],
    },
  },
  // --- Syntax bans, one union per file class -----------------------------------
  //
  // Every block below states the WHOLE union for the files it names, because flat
  // config replaces a rule's options at the last matching object. The order is
  // widest-first: a later block is either a narrower subtree that ADDS selectors, or a
  // file class that LIFTS one and restates the rest.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        EXPORT_DEFAULT_DECLARATION,
        DIRECTORY_SOURCE_GLOB,
        TEXT_SNAPSHOT_MATCHER_REACH,
      ],
    },
  },
  {
    // The main process spawns for real — the daemon supervisor and the PTY sidecar —
    // and it does so through its own supervised lifetimes rather than through the test
    // door, so what it carries is the dynamic-reach pair beside the import ban below.
    files: ["src/main/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        EXPORT_DEFAULT_DECLARATION,
        DIRECTORY_SOURCE_GLOB,
        TEXT_SNAPSHOT_MATCHER_REACH,
        ...CHILD_PROCESS_DYNAMIC_REACH,
      ],
    },
  },
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...RENDERER_SYNTAX_BANS] },
  },
  {
    files: ["src/renderer/src/console/**/*.{ts,tsx}", "src/renderer/src/shell/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...CONSOLE_SYNTAX_BANS] },
  },
  {
    // The stylesheet owners, renderer-wide: a directory's own door and the root of a
    // lazily-loaded chunk are where a sheet is SUPPOSED to enter.
    files: rendererFiles("**", STYLESHEET_OWNER_FILES),
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(RENDERER_SYNTAX_BANS, STYLESHEET_THROUGH_OWNER),
      ],
    },
  },
  {
    files: [
      ...rendererFiles("console/**", STYLESHEET_OWNER_FILES),
      ...rendererFiles("shell/**", STYLESHEET_OWNER_FILES),
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(CONSOLE_SYNTAX_BANS, STYLESHEET_THROUGH_OWNER),
      ],
    },
  },
  {
    // Suites and their scaffolding. A module-level `let` reassigned in `beforeEach` is
    // the standard vitest shape and holds no state anything else can reach, so the ban
    // on shared runtime singletons is lifted here and every other selector restated.
    //
    // The bridge-global ban comes off for the same reason the console tests' does: a
    // renderer suite INSTALLS a fixture bridge on the global and deletes it again in
    // `afterEach`, and that installation is the substitution seam the ban exists to
    // protect rather than a second reader of it.
    files: rendererFiles("**", RENDERER_TEST_FILES),
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(RENDERER_SYNTAX_BANS, MODULE_LEVEL_LET, BRIDGE_GLOBAL_READ),
      ],
    },
  },
  {
    files: [
      ...rendererFiles("console/**", RENDERER_TEST_FILES),
      ...rendererFiles("shell/**", RENDERER_TEST_FILES),
    ],
    rules: {
      // The bridge-global ban comes off here and only here among the bans: a console
      // test INSTALLS a fixture bridge on the global, and that installation is the
      // substitution seam the ban exists to protect rather than a second reader of it.
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(CONSOLE_SYNTAX_BANS, MODULE_LEVEL_LET, BRIDGE_GLOBAL_READ),
      ],
    },
  },
  {
    // The two time-ban negative controls, which have to CALL the banned API to
    // demonstrate what it answers. Everything else the console carries stays on.
    files: CONSOLE_TIME_READING_EXEMPT_FILES,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(
          CONSOLE_SYNTAX_BANS,
          MODULE_LEVEL_LET,
          BRIDGE_GLOBAL_READ,
          ...CONSOLE_TIME_READING_SELECTORS,
        ),
      ],
    },
  },
  {
    // The one console module that may read the bridge off the window. `BridgeProvider`
    // calls into it and hands the result down as context, so every surface above takes
    // the bridge FROM here and the ban is lifted exactly here and nowhere else.
    files: ["src/renderer/src/console/bridge/live-bridge.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(CONSOLE_SYNTAX_BANS, BRIDGE_GLOBAL_READ),
      ],
    },
  },
  {
    // The two LEGACY renderer modules that read the bridge off the global directly,
    // exempted by NAME rather than by leaving the rule scoped to two subtrees. The
    // difference is the whole point: a named exemption freezes the count at two and
    // makes a third reader a lint failure in the diff that adds it, where a subtree
    // scope would admit one silently.
    //
    // One of them reads `window.sidekicks.daemon` with NO existence check at all,
    // where `readInstalledBridge` (`console/bridge/live-bridge.ts`) answers `undefined`
    // for both the absent and the misshapen global — so under a preload that failed to
    // install it throws inside a render. The migration is to take the bridge from
    // `BridgeProvider`'s context as every console surface does; it is a real layering
    // change (the provider lives under `console/`) and belongs in its own diff, which
    // is why the state is recorded here rather than papered over.
    //
    // Every other selector is restated: this block replaces the renderer union for
    // these files, and dropping one would lift it for exactly the files least able to
    // afford it.
    files: [
      "src/renderer/src/session-bootstrap/SessionBootstrap.tsx",
      "src/renderer/src/runtime-node-attach/attach-request.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(RENDERER_SYNTAX_BANS, BRIDGE_GLOBAL_READ),
      ],
    },
  },
  {
    files: ["test/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...TEST_SYNTAX_BANS] },
  },
  {
    files: ["test/console/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...CONSOLE_TIER_SYNTAX_BANS] },
  },
  {
    // The capture door itself, and nothing else. The tier compares nothing since
    // 2026-09-09, so the probe that used to assert the matcher REJECTS is gone with
    // the comparison it probed, and this exemption is one file wide.
    files: ["test/console/screenshot/settled-capture.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(CONSOLE_TIER_SYNTAX_BANS, SCREENSHOT_MATCHER_REACH),
      ],
    },
  },
  {
    // The spawn door. It registers the kill on `onTestFinished`, which runs on a pass,
    // on a failure, and on vitest's own timeout kill alike.
    files: ["test/helpers/electron-child.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...withoutSelectors(TEST_SYNTAX_BANS, ...CHILD_PROCESS_DYNAMIC_REACH),
      ],
    },
  },
  {
    files: ["scripts/**/*.{ts,mts}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        EXPORT_DEFAULT_DECLARATION,
        TEXT_SNAPSHOT_MATCHER_REACH,
        ...CHILD_PROCESS_DYNAMIC_REACH,
      ],
    },
  },
  {
    files: ["build/**/*.{ts,mts}"],
    rules: {
      "no-restricted-syntax": ["error", EXPORT_DEFAULT_DECLARATION, TEXT_SNAPSHOT_MATCHER_REACH],
    },
  },
  {
    // The Vitest configuration modules, which the `lint` script reads since 2026-09-09
    // and which are where the process-wide snapshot mode is set in the first place.
    // They carry no other syntax ban — `export default` is how a Vitest config is
    // written and no block above claims this directory — so the union is the one
    // selector rather than a restatement of somebody else's.
    files: ["vitest/**/*.{ts,mts}"],
    rules: { "no-restricted-syntax": ["error", TEXT_SNAPSHOT_MATCHER_REACH] },
  },
  {
    // A declaration file carries no runtime code — no call, no assignment, no import of
    // a stylesheet — so every selector above is unreachable in one, and the `export
    // default` inside an ambient `declare module` is how a virtual module that DOES
    // default-export is typed (`~icons/*` in `console-env.d.ts`).
    files: ["**/*.d.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  // --- The refresh cadence: no wall-clock polling in the renderer ----------------
  //
  // Every refresh goes through `console/store/read/refresh-scheduler.ts`, which the console's own
  // read scheduling is built on. A `setInterval` beside it is a second cadence nothing
  // cancels on unmount, nothing pauses when the window is hidden, and nothing bounds
  // when the daemon stops answering. Both spellings, because `window.setInterval` and
  // the bare global are the same timer reached two ways.
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "setInterval",
          message:
            "The chokepoint rules in `apps/desktop/AGENTS.md`: every refresh goes through `console/store/read/refresh-scheduler.ts`. A `setInterval` is a second cadence nothing cancels on unmount, nothing pauses when the window is hidden, and nothing bounds when the daemon stops answering.",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "window",
          property: "setInterval",
          message:
            "The chokepoint rules in `apps/desktop/AGENTS.md`: every refresh goes through `console/store/read/refresh-scheduler.ts`. A `setInterval` is a second cadence nothing cancels on unmount, nothing pauses when the window is hidden, and nothing bounds when the daemon stops answering.",
        },
        {
          object: "globalThis",
          property: "setInterval",
          message:
            "The chokepoint rules in `apps/desktop/AGENTS.md`: every refresh goes through `console/store/read/refresh-scheduler.ts`. A `setInterval` is a second cadence nothing cancels on unmount, nothing pauses when the window is hidden, and nothing bounds when the daemon stops answering.",
        },
      ],
    },
  },
  // --- The spawn door, as an import ban -----------------------------------------
  //
  // The static half of the claim `CHILD_PROCESS_DYNAMIC_REACH` makes about `import()`
  // and `require`. Both specifier spellings, because `no-restricted-imports` treats
  // `child_process` and `node:child_process` as distinct. `spawnSync` is deliberately
  // absent: it settles before the statement after it, so it leaves no child for a test
  // to own.
  {
    files: ["test/**/*.{ts,tsx}", "src/main/**/*.ts", "scripts/**/*.{ts,mts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["spawn"],
              message:
                "The test rules in `apps/desktop/AGENTS.md`: `test/helpers/electron-child.ts` is the only module that reaches `spawn`, and it registers the kill on `onTestFinished` — which runs on a pass, on a failure, and on vitest's own timeout kill alike. A child a timer was going to kill is reparented to init when the worker is torn down first. `spawnSync` is untouched.",
            },
            {
              name: "child_process",
              importNames: ["spawn"],
              message:
                "The test rules in `apps/desktop/AGENTS.md`: `test/helpers/electron-child.ts` is the only module that reaches `spawn`, and it registers the kill on `onTestFinished`. The prefix-less specifier resolves to the same builtin. `spawnSync` is untouched.",
            },
          ],
        },
      ],
    },
  },
  {
    // The door itself.
    files: ["test/helpers/electron-child.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  // --- Member order: the file and class shapes `AGENTS.md` states under Module shape ---
  //
  // Scope is the console subtree ONLY — `src/renderer/src/console/**/*.{ts,tsx}`,
  // co-located tests included, since a suite reads top to bottom like anything else and
  // the three legacy renderer families predate the section these rules carry.
  //
  // Both rules run `type: "unsorted"`: the claim is the ORDER OF THE SECTIONS, never an
  // alphabet. Within a section source order is preserved exactly, so a file whose
  // sections are already right reports nothing and a reorder is pure movement. The
  // plugin's defaults for `newlinesBetween` (`"ignore"`), `partitionByComment`, and
  // `partitionByNewLine` (both `false`) are what makes that true — none of the three is
  // set here, and none of them adds or removes a blank line.
  //
  // `eslint-plugin-perfectionist` is the one library the structure-enforcement axis
  // admits. `@typescript-eslint/member-ordering` stays frozen
  // out, and no other perfectionist rule is enabled.
  {
    files: ["src/renderer/src/console/**/*.{ts,tsx}"],
    plugins: { perfectionist },
    rules: {
      "perfectionist/sort-modules": ["error", { type: "unsorted", groups: CONSOLE_MODULE_GROUPS }],
      "perfectionist/sort-classes": ["error", { type: "unsorted", groups: CONSOLE_CLASS_GROUPS }],
    },
  },
];
