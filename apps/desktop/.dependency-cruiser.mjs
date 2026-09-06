// Layering gate for `apps/desktop` (`Spec-023 §Console Libraries`, structure-enforcement row).
//
// It answers one question the type system cannot: which module is allowed to import which.
// ESLint's `no-restricted-imports` already owns the renderer-untrusted specifier bans, and it
// keeps them — a `files`-scoped specifier ban is exactly what that rule is for. What it cannot
// express is an ORDERING over N families, because flat config replaces a rule's options at the
// last matching block, so every family would have to restate the whole list of families above
// it. That table lives here instead.
//
// Resolution runs through `enhanced-resolve` with an explicit extension list, NOT through
// `--ts-config`. dependency-cruiser resolves a tsconfig's `extends` chain against the process
// directory rather than against the tsconfig's own directory, so a tsconfig whose `extends`
// climbs above its package only loads when the cruise runs from that exact directory — and this
// tree declares no path aliases, so the flag would buy a working-directory constraint and
// nothing else. The extension list is what makes this tree's `./foo.js` specifiers resolve to
// `foo.ts` sources.
//
// Paths are relative to `apps/desktop`; run it through `pnpm structure:layering`.
//
// The family vocabulary this reasons over — the homes, the ladders, and the named
// exemptions — is `.dependency-cruiser.families.mjs` beside this file.

import {
  ABOVE_BRIDGE,
  ABOVE_CORE,
  ABOVE_PALETTE,
  ABOVE_PRIMITIVES,
  ABOVE_ROUTING,
  ABOVE_SEATS,
  ABOVE_STATE,
  ABOVE_TOKENS,
  BRIDGE,
  COMPOSITION_PANE_BOARD,
  COMPOSITION_ROOT_FILES,
  CONSOLE,
  CONSOLE_BARRELS,
  CONSOLE_FAMILY_DOORS,
  CORE,
  CROSS_PROCESS_SHARED,
  LAYER_FAMILIES,
  PALETTE,
  PANE_BOARD_SUBDIRECTORY,
  PRIMITIVES,
  ROUTING,
  SEATS,
  SHELL,
  STATE,
  TEST_SUPPORT_MODULES,
  TOKENS,
  VIEW_FAMILIES,
  upwardEdge,
} from "./.dependency-cruiser.families.mjs";

export default {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "A cycle makes module initialisation order load-bearing and un-reviewable. Break it by " +
        "hoisting the shared symbol into the lower family, not by deep-importing past a barrel.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment:
        "A module with no dependents AND no dependencies is connected to nothing. This is a " +
        "narrower claim than the dead-code gate's: `knip` owns reachability from the entry " +
        "points, this owns total disconnection, and neither subsumes the other. Ambient " +
        "declarations, stylesheets, and tool configuration are roots, not orphans — and so " +
        "is a `.test-support.*` module, whose only legitimate dependents are the suites " +
        "`options.exclude` below removes from the graph BEFORE this rule runs. Its emptiness " +
        "is a property of that exclusion rather than of the module, and the gate that does " +
        "own its reachability is `knip`, which sees the test entries and reports an unused " +
        "export there like any other. That `only legitimate dependents` clause is a check " +
        "rather than a claim: `test-support-has-no-shipping-reader` below is the rule that " +
        "holds it.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.(ts|mts)$",
          "\\.css$",
          "\\.json$",
          "(^|/)[^/]+\\.config\\.(ts|mjs|cjs|js)$",
          "\\.test-support\\.(ts|tsx)$",
        ],
      },
      to: {},
    },
    {
      name: "test-support-has-no-shipping-reader",
      comment:
        "A module that SHIPS imported a `.test-support` module. The rule above already says " +
        "what a `.test-support` module is for — its only legitimate dependents are the suites " +
        "`options.exclude` removes from the graph — and until this rule that was a sentence " +
        "rather than a check: nothing anywhere forbade a production module from importing one. " +
        "That matters most where a subtraction was written for the test-support class, because " +
        "`renderer-reaches-console-through-doors` and `console-cross-family-deep-import` both " +
        "subtract it from their SOURCE side, so a production module that imported a " +
        "`.test-support` sibling would reach whatever that sibling reaches with neither rule " +
        "reporting a thing. It can only fire on an importer still in the graph — which, after " +
        "the exclusion, is a module that ships — so the remedy is never an exemption here: " +
        "either the symbol belongs to production, in which case it moves into a module that " +
        "ships, or the importer belongs to a suite, in which case it is named `.test-support` " +
        "itself and is subtracted like every other.",
      severity: "error",
      from: { pathNot: [TEST_SUPPORT_MODULES] },
      to: { path: TEST_SUPPORT_MODULES },
    },
    {
      name: "renderer-not-main",
      comment:
        "The renderer is untrusted. It reaches the main process only across the context bridge; " +
        "a value both sides need lives in `src/shared/`.",
      severity: "error",
      from: { path: "^src/renderer/" },
      to: { path: "^src/(main|preload)/" },
    },
    {
      name: "main-not-renderer",
      comment:
        "Main and preload never import renderer source. A value both sides need lives in " +
        "`src/shared/` and is imported by both, never mirrored by hand.",
      severity: "error",
      from: { path: "^src/(main|preload)/" },
      to: { path: "^src/renderer/" },
    },
    {
      name: "shared-imports-nothing",
      comment:
        "`src/shared/` is the one cross-process leaf: types and pure functions main, preload, " +
        "and the renderer all need. It may import the contracts package and nothing else — an " +
        "`electron`, `node:*`, or React import there would make it unimportable by one of its " +
        "three consumers.",
      severity: "error",
      from: { path: CROSS_PROCESS_SHARED },
      // Both spellings of the one allowed target, and both are reachable: the contracts
      // package resolves into `node_modules/@ai-sidekicks/contracts/` once it has been built
      // and carries its bare specifier as its path when it has not, so the shape of this edge
      // depends on the build state of a sibling package. Measured both ways — the graph grows
      // by the resolved package's modules and the violation set does not move.
      to: {
        pathNot: "^(src/shared/|node_modules/@ai-sidekicks/contracts|@ai-sidekicks/contracts)",
      },
    },
    {
      name: "console-not-plan-subtree",
      comment:
        "A plan-owned subtree whose owner MOUNTS INTO the console reaches the frame by calling " +
        "`registerConsoleSurface`, which is a call and not an import — so the console imports " +
        "it through no path, and this rule takes no exception. It is deliberately not a ban on " +
        "every sibling subtree: Plan-023's Phase-1C rule has the console absorb the shipped " +
        "Tier-1 components (`session-bootstrap/`, `session-members/`, `runtime-node-attach/`) " +
        "by import, and a gate stricter than its own plan is a defect. A later plan whose page " +
        "mounts into the console adds its subtree to this list.",
      severity: "error",
      from: { path: `${CONSOLE}/` },
      to: {
        path:
          "^src/renderer/src/(timeline|usage-meters|run-controls|provider-accounts|" +
          "sidekick-definitions|mcp-governance)/",
      },
    },
    {
      name: "console-not-shell",
      comment:
        "The console imported the shell. `src/renderer/src/shell/` composes console seats and " +
        "therefore sits ABOVE the whole console DAG — it is the shell that mounts the console, " +
        "never the other way round — so an edge from `console/` into it is an upward edge like " +
        "any other, and it was the one upward edge no rule here could see: the ladders below " +
        "are scoped inside `${CONSOLE}/` on both endpoints, `console-not-plan-subtree` " +
        "enumerates six mounted plan subtrees that do not include the shell, and " +
        "`no-circular` only fires once the edge comes back. A body the console mounts belongs " +
        "in the view family that mounts it; a contract both sides need belongs in `seats/`. " +
        "The composition root files are subtracted for the reason they are subtracted from the " +
        "view-family rule: `families.ts` composes the shell's own `registerComposerFamily` in, " +
        "which is what makes the shell a seat above the console rather than a body inside it.",
      severity: "error",
      from: { path: `${CONSOLE}/`, pathNot: COMPOSITION_ROOT_FILES },
      to: { path: SHELL },
    },
    {
      name: "renderer-reaches-console-through-doors",
      comment:
        "A renderer subtree OUTSIDE the console deep-imported a console module. Every layering " +
        "rule here is `from`-scoped to `console/`, so an importer that lives beside the console " +
        "rather than inside it matches none of them — which is how a Tier-1 subtree came to hold " +
        "`console/store/subject-scoped-state.js` while three gates reported clean and the door " +
        "the symbol is published from could have been deleted without one of them noticing. " +
        "Import the family door instead (`console/store/index.js` publishes the subject-scoped " +
        "holder for exactly this reason). A symbol no door publishes is a symbol the console has " +
        "not offered, and reaching around the door inverts that decision rather than respecting " +
        "it. A `.test-support` module is subtracted from the SOURCE side for the reason " +
        "`console-cross-family-deep-import` subtracts it: it is part of a suite rather than " +
        "something that ships, and both remedies this rule offers are closed to it. The door " +
        "cannot publish what it needs — `barrel-census` fails a door specifier no PRODUCTION " +
        "module reads, and a fixture helper has no production reader by construction — and " +
        "hoisting is no answer either, because the symbol is test-only and has no home below " +
        "the family whose fixture it drives. Measured on the composer family: six such " +
        "modules, thirteen edges, five door lines, seven census findings when the names were " +
        "published. The rule was written against a production defect (a Tier-1 subtree holding " +
        "`subject-scoped-state.js`) and its silence about test support was an omission rather " +
        "than a decision; production modules outside the console are still held to the door, " +
        "which is the claim that matters.",
      severity: "error",
      from: { path: "^src/renderer/src/(?!console/)", pathNot: [TEST_SUPPORT_MODULES] },
      to: { path: `${CONSOLE}/`, pathNot: CONSOLE_FAMILY_DOORS },
    },
    upwardEdge("core", CORE, ABOVE_CORE),
    upwardEdge("tokens", TOKENS, ABOVE_TOKENS),
    upwardEdge("routing", ROUTING, ABOVE_ROUTING),
    upwardEdge("primitives", PRIMITIVES, ABOVE_PRIMITIVES),
    upwardEdge("store-persistence", STATE, ABOVE_STATE),
    upwardEdge("bridge", BRIDGE, ABOVE_BRIDGE),
    upwardEdge("seats", SEATS, ABOVE_SEATS),
    upwardEdge("palette", PALETTE, ABOVE_PALETTE),
    {
      name: "console-layering-view-families",
      comment:
        "A layer family imported a VIEW family. The view families sit at the top of the DAG " +
        "and import the layers below them; an edge back down means the layer is reaching for " +
        "a body. Hoist the contract into the lowest layer that needs it — `seats/` is where " +
        "the pane, composer, sidebar, timeline-row, and inline-card contracts live for exactly " +
        "this reason — and never deep-import around it. This rule is stated once for all nine " +
        "layer families rather than per family, because its target set is everything in the " +
        "console that is NOT a layer family or a composition site: a new view family is covered " +
        "the moment its directory exists, with no line to remember.",
      severity: "error",
      from: { path: LAYER_FAMILIES },
      to: VIEW_FAMILIES,
    },
    {
      name: "console-view-family-isolation",
      comment:
        "One VIEW family imported another. View families are siblings, not a ladder: the rule " +
        "above only forbids a LAYER family reaching up into a view family, so without this one " +
        "`collaboration/` → `repos/` stayed green and the six concurrent family branches could " +
        "grow edges into each other that no ordering could ever untangle. Hoist the shared " +
        "contract into `seats/` — that is what `seats/` is for — or into the lowest layer " +
        "family that needs it. The two composition sites are the only files that name more " +
        "than one view family, and they are subtracted from BOTH endpoints below, as they are " +
        "from the view-family set itself.",
      severity: "error",
      // The top-level owner is captured from the source and subtracted from the target, so
      // this is one rule over N families rather than N² pairs: a family added by a branch is
      // covered the moment its directory exists. Intra-family edges — the common case — are
      // the ones `$1` removes.
      from: { path: `${CONSOLE}/([^/]+)/`, pathNot: VIEW_FAMILIES.pathNot },
      to: { path: `${CONSOLE}/`, pathNot: [...VIEW_FAMILIES.pathNot, `${CONSOLE}/$1/`] },
    },
    {
      name: "console-view-family-shared-through-core",
      comment:
        "A VIEW family imported `src/shared/` directly. The cross-process leaf is not a " +
        "console family and sits under no rung of the DAG, so the ordering rules say nothing " +
        "about it and a view family could reach it while every gate stayed green — which " +
        "would put a second reader of a shared shape above the layer that owns it, exactly " +
        "the shape `console-view-family-isolation` forbids between two families. The console " +
        "reaches shared code through the layer family that owns the concern, and today that " +
        "is `core/`: every console consumer of `src/shared/` goes through it, so this rule " +
        "pins what the tree already does rather than asking for a change. A view family that " +
        "needs a shared symbol hoists its use into the lowest layer family that can own it " +
        "and imports THAT family's door.",
      severity: "error",
      from: VIEW_FAMILIES,
      to: { path: CROSS_PROCESS_SHARED },
    },
    {
      name: "console-root-is-composition-only",
      comment:
        "A module at the console ROOT that is not one of the enumerated composition sites " +
        "imported a console module. The root is where a composition lives because a composition " +
        "is the one thing that may name more than one view family — so a file that lands there " +
        "and is not on the list is a family importing a sibling with the isolation rule stepped " +
        "around, which is one `git mv` of work. `console-view-family-isolation` cannot see it: " +
        "its `from` captures the owning DIRECTORY (`console/<family>/`) so it can subtract that " +
        "family from its own target set, and a root file has no directory to capture. This rule " +
        "is that complement, so the console root is closed from the SOURCE side and the " +
        "enumeration closes it from the target side. A family whose registrar belongs at the " +
        "root adds one alternative to `COMPOSITION_ROOT_FILES` and names itself doing it.",
      severity: "error",
      // Declaration files are subtracted for the reason `no-orphans` subtracts them: they
      // declare ambient types rather than participate in the graph. `console-env.d.ts`
      // imports nothing today, so it is an edge source in no cruise — the entry states the
      // disposition rather than waiting for one that does.
      from: { path: `${CONSOLE}/[^/]+$`, pathNot: [COMPOSITION_ROOT_FILES, "\\.d\\.ts$"] },
      to: { path: `${CONSOLE}/` },
    },
    {
      name: "console-cross-family-deep-import",
      comment:
        "A console family reached into another family's module instead of its door. " +
        "`apps/desktop/AGENTS.md` §Module shape: cross-family imports go through the " +
        "family door, intra-family imports are deep. The two rules above order the " +
        "families and keep view families apart; neither says anything about HOW a " +
        "permitted edge is written, so a downward edge past a barrel — the shape a " +
        "caller reaches for when importing the door would close a cycle — stayed green. " +
        "The fix is never the deep specifier: hoist the symbol to the lowest family " +
        "that owns its inputs, and import it from that family's door. WHERE THE " +
        "TARGET IS `frame/`, THE FRAME'S OWN DOOR IS NOT AN AVAILABLE REMEDY for a " +
        "view family: `frame/index.ts` re-exports `ConsoleRoot`, `ConsoleRoot.tsx` " +
        "imports `console/families.ts`, and `families.ts` composes every view family " +
        "in, so `families.ts → <family>/index.ts → frame/index.ts → ConsoleRoot.tsx " +
        "→ families.ts` is a cycle `no-circular` fails — measured. Hoisting is the " +
        "only remedy open there, and the substrate has already taken it for the " +
        "command registry, the surface-scale absence and the error boundary. A " +
        "sub-module " +
        "door (`bridge/growth-values/`, `bridge/scenarios/`) is deliberately NOT a " +
        "legal target here — it publishes to its own family only, which is why the " +
        "exemption below matches a family door's single path segment and not a nested " +
        "one. The pane board is subtracted at the TO end only. It is a legal target " +
        "because it sits above every family by construction; it is not a legal SOURCE, " +
        "because standing above the families says nothing about how a file there writes " +
        "an edge, and subtracting it here made the rule silent about the one directory " +
        "whose whole job is to name every family — eleven deep specifiers into a family's " +
        "projection, park badge and refusal helpers read as composition and were reported " +
        "as nothing.",
      severity: "error",
      from: { path: `${CONSOLE}/([^/]+)/`, pathNot: [TEST_SUPPORT_MODULES] },
      to: {
        path: `${CONSOLE}/[^/]+/`,
        pathNot: [`${CONSOLE}/$1/`, CONSOLE_FAMILY_DOORS, COMPOSITION_PANE_BOARD],
      },
    },
    {
      name: "console-panes-hold-no-body",
      comment:
        "A module was authored under `console/panes/<something>/`. A pane BODY lives in the " +
        "family that owns it — `<family>/pane/` — and `panes/` holds composition only: one " +
        "reserved line per family, replaced by that family, so six branches produce six " +
        "one-line diffs and none of them conflicts. A body parked under the board is a body " +
        "no family owns, and it is invisible to the sibling-isolation rule the six families " +
        "are held to. Move it into its family and register it from the board.",
      severity: "error",
      from: { path: PANE_BOARD_SUBDIRECTORY },
      to: {},
    },
    {
      name: "console-panes-hold-no-imported-body",
      comment:
        "Something imported a module under `console/panes/<something>/`. Same rule as " +
        "`console-panes-hold-no-body`, stated from the other endpoint, because these rules " +
        "match EDGES rather than directories: a body that imports nothing at all — a table, a " +
        "closed set — would be reported by neither its own outgoing edges nor the orphan rule, " +
        "since the board imports it and so it has a dependent.",
      severity: "error",
      from: {},
      to: { path: PANE_BOARD_SUBDIRECTORY },
    },
    {
      name: "console-no-barrel-chain",
      comment:
        "A barrel re-exported from another barrel. A family door publishes its own family's " +
        "modules and a sub-module door (`bridge/growth-values/`, `bridge/scenarios/`) publishes " +
        "its own directory's; forwarding a symbol through a second `index.ts` makes its home a " +
        "matter of following two hops, and it lets a family door publish a name it never " +
        "declared. Re-export from the module that DECLARES the symbol. This matches only the " +
        "`export … from` dependency type, so a composition site importing a family door for a " +
        "type it uses in a signature — which `panes/index.ts` does — is not a chain and is not " +
        "reported.",
      severity: "error",
      from: { path: CONSOLE_BARRELS },
      to: { path: CONSOLE_BARRELS, dependencyTypes: ["export"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Test files are not subjects of the layering DAG: a `console-unit` test legitimately
    // reaches across families to drive the module it covers, and reaches both process trees to
    // assert the boundary between them.
    exclude: { path: "\\.(test|bench)\\.(ts|tsx)$|__tests__/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
  },
};
