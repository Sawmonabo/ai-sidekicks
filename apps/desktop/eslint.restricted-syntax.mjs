// This package's `no-restricted-syntax` selectors: the renderer's single-reading chokepoints and
// the syntax bans the renderer, main-process and test blocks compose.
//
// A sibling of the flat config, not a second config: `eslint.config.mjs` composes these selectors
// into its own blocks, so one file states what this package may not write. They live here so the
// import boundary stays findable in the config; the package holds one concept per file, and the
// import boundary and the syntax bans are two.
//
// Selectors, not a config block, by necessity: flat config replaces a rule's options at the last
// matching object, so a block declared here would delete every renderer-scoped selector
// `eslint.config.mjs` declares for the same files, or be deleted by them. Exporting selectors lets
// that file state one union per file class, the only shape in which two authors can both add a
// selector and both survive.
//
// Only `eslint.config.mjs` imports this module.

/**
 * How this package spells a wire instant, as a regular-expression source. One declaration for every
 * selector below that keys on the name of a stamp.
 */
const WIRE_STAMP_NAME_SUFFIX = "(?:At|Iso)$";

/**
 * How the renderer spells a numeric instant, the one construction `new Date(...)` leaves open.
 *
 * It comes from a search of this tree: the only bare name any `new Date(...)` in the renderer
 * passes is `sequence`, a fixture counter, and the millisecond and epoch suffixes are how the
 * package spells a numeric instant wherever it composes one
 * (`ATTENTION_SCENARIO_STARTED_AT_MILLISECONDS + atMs`). A name outside this set is refused, the
 * opposite of a heuristic that cannot see `new Date(iso)`.
 *
 * Both naming conventions are covered: camelCase locals and SCREAMING_SNAKE module constants.
 * Without the second, a test-tier file naming its instant the way this package names every module
 * constant would be refused for its spelling rather than the reading, a false alarm of the kind
 * that gets a ban switched off.
 */
const NUMERIC_INSTANT_NAME_SUFFIX =
  "(?:Ms|Milliseconds|Epoch|[Ss]equence|_MS|_MILLISECONDS|_EPOCH)$";

/**
 * The renderer's time-reading bans.
 *
 * They are not import bans, so `no-restricted-imports` cannot express them. `eslint.config.mjs`
 * decides the scope and composes them into the renderer and test-tier unions. The tiers are
 * included because a fixture composed with `Date.parse` records the host's zone into an expectation
 * the surface under test is then measured against, the same defect as the production one arriving
 * through the file meant to catch it.
 *
 * `String(...)` of a catch binding has no selector here. esquery has no backreference, so a
 * selector cannot bind a catch parameter and compare it to the identifier being stringified, and
 * the spellings outside a `CatchClause` (`"" + error`, `error.toString()`,
 * `.catch((error) => …)`) are out of reach. A selector that catches half a class reads exactly
 * like one that catches the class, so that claim is left to review.
 */
export const TIME_READING_SELECTORS = [
  {
    // The reference, not only the call. `Date.parse(iso)` is the spelling this ban was written
    // against, and three more reach the same function without writing those two names in that
    // order: a destructure (`const { parse } = Date; parse(iso)`), a computed key
    // (`Date["parse"](iso)`), and a read through the global object (`globalThis.Date.parse(iso)`).
    // Keying on the member read catches the value wherever it is taken.
    //
    // The destructuring arm is written against the pattern because that shape has no member read:
    // it names `Date` as an initializer and takes whatever it likes off it. It therefore refuses
    // `const { now } = Date` too, deliberately: `lib/clock.ts` is the renderer's one time source
    // and reaches `Date.now` through the object.
    selector:
      `:matches(MemberExpression[object.name="Date"][property.name="parse"], ` +
      `MemberExpression[object.name="Date"][property.value="parse"], ` +
      `MemberExpression[object.property.name="Date"][property.name="parse"], ` +
      `MemberExpression[object.property.name="Date"][property.value="parse"], ` +
      `VariableDeclarator[init.name="Date"] > ObjectPattern)`,
    message:
      "`Date.parse` is not a validator: it reads a timezone-less stamp in the HOST's zone, reads " +
      "a date-only string in UTC, and normalizes a day that does not exist " +
      "(`2026-02-30T10:00:00Z` becomes March 2). Each answers a NUMBER, so the `Number.isNaN` " +
      "guard passes and a surface renders an instant the wire never sent. Read the stamp with " +
      "`parseInstant` from `lib/instant.ts`, and order two of them with `compareInstants`. " +
      "Taking the function off `Date` by a destructure, a computed key, or the global object " +
      "reaches the same reading.",
  },
  {
    // A string-shaped argument only. `new Date(<milliseconds>)` is how a fixture composes an
    // instant from a base and an offset and stays legitimate; a numeric literal can carry none of
    // `-`, `:` or `T`, and a negative one is a `UnaryExpression`, not a `Literal`, so neither
    // matches.
    selector:
      'NewExpression[callee.name="Date"] > :matches(TemplateLiteral, Literal[value=/[-:T]/])',
    message:
      "`new Date(<string>)` is `Date.parse` with a wrapper and carries the same leniency. Read " +
      "the stamp with `parseInstant` from `lib/instant.ts`; build a fixture instant from " +
      "`Date.UTC(...)` instead of parsing one.",
  },
  {
    // The named form, inverted: a `new Date` whose argument is a name is refused unless the name
    // says it is a number. Keying on stamp-shaped names (`…At`, `…Iso`) fails because
    // `formatClockTime(iso: string)` in `lib/wire/figures.ts` carries a wire stamp under a
    // lower-case name. Inverted, a new stamp name is caught, and a new numeric name is a one-word
    // edit to `NUMERIC_INSTANT_NAME_SUFFIX` that a reviewer sees. A sum or a call is not a name and
    // is outside the arm, so `new Date(base + offsetMs)` and `new Date(Date.UTC(...))` still pass.
    selector:
      `:matches(NewExpression[callee.name="Date"][arguments.0.type="Identifier"]` +
      `[arguments.0.name!=/${NUMERIC_INSTANT_NAME_SUFFIX}/], ` +
      `NewExpression[callee.name="Date"][arguments.0.type="MemberExpression"]` +
      `[arguments.0.property.name!=/${NUMERIC_INSTANT_NAME_SUFFIX}/])`,
    message:
      "`new Date(<a named value>)` is `Date.parse` with a wrapper and carries the same leniency " +
      "— it just does not look like it, because the " +
      "string is behind a name. Read the stamp with " +
      "`parseInstant` from `lib/instant.ts`; build a fixture instant from `Date.UTC(...)`, or " +
      "name the value for the number it holds (`…Ms`, `…Milliseconds`, `…Epoch`).",
  },
  {
    // Ordering two stamps by their text. `compareInstants` exists because the wire's stamps are not
    // lexically ordered: an offset form and a `Z` form naming the same moment differ, and
    // `2026-01-01T00:00:00+01:00` sorts after `2026-01-01T00:00:00Z` while naming an earlier moment
    // (`lib/instant.ts` states this and its suite asserts it).
    //
    // The call is the match and the stamp is looked for anywhere inside it, so
    // `(row.touchedAt ?? "").localeCompare(...)` (a `LogicalExpression` receiver, what a caller
    // writes for a `string | undefined` stamp) and `String(row.touchedAt).localeCompare(...)` are
    // caught.
    //
    // `localeCompare` on anything else is untouched: sorting a display path, a repo name or a
    // handle is what it is for.
    selector:
      `CallExpression[callee.property.name="localeCompare"]` +
      `:has(:matches(MemberExpression[property.name=/${WIRE_STAMP_NAME_SUFFIX}/], ` +
      `Identifier[name=/${WIRE_STAMP_NAME_SUFFIX}/]))`,
    message:
      "Two RFC 3339 stamps are not lexically ordered: an offset form and a `Z` form naming the " +
      "same moment differ, and a `+01:00` stamp sorts AFTER the `Z` stamp it PRECEDES. Order " +
      "them with `compareInstants` from `lib/instant.ts`, which compares the moments; " +
      "`localeCompare` on a name, a path, or a handle is untouched.",
  },
  {
    // The shorter spelling of the same defect, which `lib/instant.ts` names beside `localeCompare`:
    // `<` is what a comparator reaches for first.
    //
    // Both sides must name a stamp, for precision: this tree carries two `…At` figures that are
    // numbers (`dueAt` on the frozen clock's entries in `lib/clock.ts`, `updatedAt` on a
    // persistence record in `store/persistence/persistence-adapter.ts`) and both are compared
    // against a plain identifier, so a one-sided name key would flag them falsely.
    //
    // The third arm is the wrapped form, where one side is enough: a stamp reached through `?? ""`
    // or `String(...)` inside a comparison is being ordered as text whatever sits opposite it. It
    // is keyed on the direct child so a comparison that merely contains a stamp somewhere
    // (`rows.filter((row) => row.createdAt).length > 0`) is not swept in.
    selector:
      `:matches(BinaryExpression[operator=/^[<>]=?$/]` +
      `[left.property.name=/${WIRE_STAMP_NAME_SUFFIX}/]` +
      `[right.property.name=/${WIRE_STAMP_NAME_SUFFIX}/], BinaryExpression[operator=/^[<>]=?$/]` +
      `[left.name=/${WIRE_STAMP_NAME_SUFFIX}/][right.name=/${WIRE_STAMP_NAME_SUFFIX}/], ` +
      `BinaryExpression[operator=/^[<>]=?$/]:has(> :matches(LogicalExpression, ` +
      `CallExpression):has(:matches(MemberExpression[property.name=/${WIRE_STAMP_NAME_SUFFIX}/], ` +
      `Identifier[name=/${WIRE_STAMP_NAME_SUFFIX}/]))))`,
    message:
      "Ordering two RFC 3339 stamps with `<` or `>` compares their TEXT: an offset form and a " +
      "`Z` form naming the same moment differ, and a `+01:00` stamp sorts AFTER the `Z` stamp it " +
      "PRECEDES. Order them with `compareInstants` from `lib/instant.ts`, which compares the " +
      "moments; comparing two numeric figures is untouched.",
  },
];

/**
 * The files the time bans are lifted for, and the only ones.
 *
 * Each is a negative control that has to call the banned API to show that `Date.parse` answers a
 * number for a value RFC 3339 refuses. An exempt file is exempt from every selector composed for
 * it, so a `Date.parse` landing in one would stay green; keep the set to files that need the call.
 */
export const TIME_READING_EXEMPT_FILES = ["src/renderer/src/lib/instant.test.ts"];

/**
 * The renderer's exported-collection ban.
 *
 * Its own export because it is a different claim about a different subject (module shape rather
 * than wire readings) and `eslint.config.mjs` composes the two into different unions: the time bans
 * are lifted for the negative controls above, and this one is lifted for nothing.
 */
export const EXPORTED_COLLECTION_SELECTOR = {
  // A collection a module exports, which the State and views rules in `apps/desktop/AGENTS.md`
  // reject and no other gate can see: a `ReadonlySet` or `ReadonlyMap`
  // annotation hides `add` and `set` from a reader and from nothing at runtime, so an exported one
  // is a single object every importer in the window shares and any of them can grow.
  // `Object.freeze` cannot close it (freezing a `Set` leaves `Set.prototype.add` working), so the
  // ban is on the container rather than on a missing freeze.
  //
  // Exported, and deliberately not every module-level one: a collection a module keeps to itself is
  // reachable from nowhere else and is a lookup table, not shared state, and banning those would
  // refuse the run states, modifier keys and empty-reading sentinels this tree is full of.
  //
  // The remedy is to export the derived data as a `readonly T[]` and let each consumer build the
  // collection it needs, once, where it needs it.
  selector:
    "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > " +
    "NewExpression[callee.name=/^(?:Set|Map|WeakSet|WeakMap)$/]",
  message:
    "An exported `Set` or `Map` is a mutable runtime singleton however it is annotated: " +
    "`ReadonlySet` and `ReadonlyMap` hide the mutators from a reader and from nothing else, " +
    "every importer shares the one object, and `Object.freeze` does not close it. Export the " +
    "derived data instead — a `readonly T[]` of " +
    "entries — and build the collection inside the " +
    "module, class, or controller that reads it. A collection this module keeps to itself is " +
    "untouched.",
};

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
export const BRIDGE_GLOBAL_READ = {
  selector:
    ':matches(MemberExpression[object.name="window"][property.name="desktopBridge"], ' +
    'MemberExpression[object.name="globalThis"][property.name="desktopBridge"], ' +
    'MemberExpression[object.type="TSAsExpression"][property.name="desktopBridge"], ' +
    'MemberExpression[computed=true][property.value="desktopBridge"], ' +
    "VariableDeclarator[init.name=/^(?:window|globalThis)$/] > ObjectPattern > " +
    'Property[key.name="desktopBridge"])',
  message:
    "Mechanical gate 1 in `apps/desktop/AGENTS.md`: renderer code reaches the bridge only " +
    "through `services/platform/live-bridge.ts`, and every surface above it takes the bridge " +
    "from the platform bridge provider's context. A second reader is a second idea of when the " +
    "bridge exists and what stands in for it under test.",
};

/**
 * `export default`, which this package uses for root tool configuration and nothing else.
 *
 * A default export has no name at the import site, so two importers can call one symbol two things
 * and a rename reaches neither. The tools that load a config by default export
 * (`*.config.{ts,mjs}`, `.dependency-cruiser.mjs`) live at the package root, outside every scope
 * this rule is composed into.
 *
 * Both spellings are banned: `export { x as default }` (and its `… from "./other.js"` form)
 * parses as an `ExportSpecifier`, not an `ExportDefaultDeclaration`, and publishes the same
 * nameless symbol. `export { default as Thing } from …` is untouched: it imports a default and
 * republishes it under a name, which is the remedy.
 */
export const EXPORT_DEFAULT_DECLARATION = {
  selector: ':matches(ExportDefaultDeclaration, ExportSpecifier[exported.name="default"])',
  message:
    "Mechanical gate 3 in `apps/desktop/AGENTS.md`: named exports only. `export default` is for " +
    "tool configuration at the package root — " +
    "`*.config.{ts,mjs}` and `.dependency-cruiser.mjs`, " +
    "which their tools load by default export — and nowhere else: a default export has no name " +
    "at the import site, so two importers can call one symbol two things and a rename reaches " +
    "neither.",
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
export const MODULE_LEVEL_LET = {
  selector: ':matches(Program, ExportNamedDeclaration) > VariableDeclaration[kind="let"]',
  message:
    "Mechanical gate 4 in `apps/desktop/AGENTS.md`: stateful logic is an encapsulated class with " +
    "private fields. A module-level `let` is a singleton every importer in the window shares and " +
    "any of them can reassign — put it in a class, " +
    "a hook, or a controller the caller constructs.",
};

/**
 * Reaching `child_process` dynamically. The static forms are `no-restricted-imports`' half of the
 * same claim; these two are the spellings that rule cannot see. `spawnSync` is untouched: it
 * settles before the next statement, so it leaves nothing behind for a test to own.
 */
export const CHILD_PROCESS_DYNAMIC_REACH = [
  {
    selector: "ImportExpression[source.value=/child_process/]",
    message:
      "Mechanical gate 5 in `apps/desktop/AGENTS.md`: `tests/helpers/electron/child/child.ts` " +
      "is the only module that reaches `spawn` from `node:child_process`, and it registers the " +
      "kill on `onTestFinished` so a spawned child's lifetime belongs to the test rather than to " +
      "a timer. Spawn through that module; `spawnSync` is untouched.",
  },
  {
    selector: 'CallExpression[callee.name="require"][arguments.0.value=/child_process/]',
    message:
      "Mechanical gate 5 in `apps/desktop/AGENTS.md`: `tests/helpers/electron/child/child.ts` " +
      "is the only module that reaches `spawn` from `node:child_process`, and it registers the " +
      "kill on `onTestFinished` so a spawned child's lifetime belongs to the test rather than to " +
      "a timer. Spawn through that module; `spawnSync` is untouched.",
  },
];

const WINDOW_CLASS_NAME = "/^(BrowserWindow|BaseWindow|WebContentsView)$/";

/**
 * A window or web view built outside the window factory. The factory holds the one locked
 * `webPreferences` block, so a construction anywhere else ships a window that block does not
 * govern.
 */
export const WINDOW_CONSTRUCTION_OUTSIDE_FACTORY = {
  selector:
    `NewExpression:matches([callee.name=${WINDOW_CLASS_NAME}], ` +
    `[callee.property.name=${WINDOW_CLASS_NAME}])`,
  message:
    "Every window and web view is built by the window factory in `src/main/windows/window.ts`, " +
    "which holds the one locked `webPreferences` block. Build it there.",
};

const HARDENED_WHEN_TRUE = "/^(contextIsolation|sandbox|webSecurity)$/";
const HARDENED_WHEN_FALSE = "/^(nodeIntegration|nodeIntegrationInWorker)$/";

/**
 * A window security setting written as anything but its hardened literal: `sandbox: false`, and
 * also `sandbox: someFlag`, whose value no reader of the source can vouch for.
 */
export const WEAKENED_WINDOW_SETTING = [
  {
    selector:
      `Property:matches([key.name=${HARDENED_WHEN_TRUE}], ` +
      `[key.value=${HARDENED_WHEN_TRUE}]):not([value.raw="true"])`,
    message:
      "`contextIsolation`, `sandbox` and `webSecurity` are written as the literal `true` in the " +
      "main process. A window with any of them off runs the renderer with more reach than the " +
      "hardening allows.",
  },
  {
    selector:
      `Property:matches([key.name=${HARDENED_WHEN_FALSE}], ` +
      `[key.value=${HARDENED_WHEN_FALSE}]):not([value.raw="false"])`,
    message:
      "`nodeIntegration` and `nodeIntegrationInWorker` are written as the literal `false` in the " +
      "main process. Either one on hands Node to the renderer.",
  },
];

/**
 * A text snapshot.
 *
 * A text snapshot records whatever the code produced on its first run and passes, so it proves
 * nothing a person decided. No such matcher exists in this package today; this keeps it that way.
 * Assert the value instead.
 *
 * Scope is every directory this package's `lint` script reads: `src/**`, `tests/**`, `fixtures/**`,
 * `scripts/**`, `build/**` and `vitest/**`. Most of `main-unit`'s `include` entries live outside
 * the renderer and `tests/**` unions, so a narrower ban would leave them unguarded. Because flat
 * config replaces a rule's options at the last matching block, the selector is added to each block
 * by name rather than declared once in a widest one.
 */
export const TEXT_SNAPSHOT_MATCHER_REACH = {
  selector:
    "MemberExpression[property.name=/^toMatch(Inline|File)?Snapshot$/], " +
    "MemberExpression[computed=true][property.value=/^toMatch(Inline|File)?Snapshot$/]",
  message:
    "Mechanical gate 9 in `apps/desktop/AGENTS.md`: a text snapshot records whatever the code " +
    "produced on its first run and passes. Assert the value.",
};

/**
 * A screenshot matcher. The package keeps no screenshot captures. A never-saved
 * `page.screenshot({ save: false })` read is a measurement, not a capture, and is outside this
 * rule, which names the matcher.
 */
export const SCREENSHOT_MATCHER_REACH = {
  // The computed arm is the same reach with the matcher named as a string —
  // `expect(page)["toMatchScreenshot"]()` — which the property-name arm cannot see.
  selector:
    ':matches(MemberExpression[property.name="toMatchScreenshot"], ' +
    'MemberExpression[computed=true][property.value="toMatchScreenshot"])',
  message:
    "Mechanical gate 6 in `apps/desktop/AGENTS.md`: no screenshot matcher; the package keeps no " +
    "screenshot captures. A never-saved `page.screenshot({ save: false })` read is outside the " +
    "rule.",
};

/**
 * A stylesheet imported from another folder.
 *
 * A component imports its own sheet from its own folder, so importing the component brings its
 * styles. Relative and `#renderer/` specifiers only: a vendor sheet reached by package specifier
 * has no owning folder here.
 *
 * A trailing query is still the sheet: `./x.css?inline` and `./x.css?raw` are bundler spellings of
 * the same import, so the match is not `$`-anchored. The dynamic form carries the sheet as the
 * static one does (the chunk it lands on is the component's), so both declarations are named.
 */
const STYLESHEET_SPECIFIER = "^(?:[.][.]?[/]|#renderer[/]).*[.]css(?:[?].*)?$";
const SAME_FOLDER_STYLESHEET_SPECIFIER = "^[.][/][^/?]+[.]css(?:[?].*)?$";
const STYLESHEET_OUTSIDE_FOLDER_SPECIFIER =
  `[source.value=/${STYLESHEET_SPECIFIER}/]` +
  `:not([source.value=/${SAME_FOLDER_STYLESHEET_SPECIFIER}/])`;

export const STYLESHEET_THROUGH_OWNER = {
  selector:
    `:matches(ImportDeclaration${STYLESHEET_OUTSIDE_FOLDER_SPECIFIER}, ` +
    `ImportExpression${STYLESHEET_OUTSIDE_FOLDER_SPECIFIER})`,
  message:
    "Mechanical gate 7 in `apps/desktop/AGENTS.md`: a component imports its own sheet from its " +
    "own folder (`X.tsx` imports `./X.css`); a sheet that styles several components of a feature " +
    "is imported by the feature's top view or its lazily-loaded chunk root (`*-body.ts`); a " +
    "global sheet in `styles/` is imported by `main.tsx`. A module that reaches into another " +
    "folder's sheet puts that surface's rules wherever the module loads.",
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
export const DIRECTORY_SOURCE_GLOB = {
  selector:
    ':matches(CallExpression[callee.object.type="MetaProperty"][callee.property.name="glob"] > ' +
    'Literal[value=/[*]/], CallExpression[callee.object.type="MetaProperty"]' +
    '[callee.property.name="glob"] > ArrayExpression > Literal[value=/[*]/])',
  message:
    "A directory `import.meta.glob` under `src/` is a second source of truth for what the tree " +
    "holds, and it decides its own membership — so " +
    "it is silently wrong the moment a file moves " +
    "and reports nothing. Name the modules, or let the bundler's own entry graph decide.",
};
