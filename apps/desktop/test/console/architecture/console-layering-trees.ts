// The module trees this tier plants, and nothing that runs over them.
//
// Every constant here is a SUBJECT rather than a claim: a handful of console modules
// written out at the relative paths the layering rules are anchored on, one tree per
// shape a rule has to report or leave alone. The cruise harness is
// `console-layering-cruise.ts` and the cases are `console-layering-rules.test.ts`,
// both beside this file — the seam the tier already takes for `barrel-census.ts` and
// `stylesheet-edge-graph.ts`: the corpus in a module of its own, the suite that
// judges it next door.
//
// The split is what keeps any of the three readable. Every rule needs a tree and
// several need more than one, each carrying the paragraph that says which rule it is
// the control for and why it offends the set it does — and a file holding those
// beside the harness, the budgets and the cases was doing three jobs at ~650 lines.
// The counts are deliberately not written down: a branch adds a rule and its tree in
// one diff, and a cardinal in this header would be the thing it forgot to move.
//
// WHY THESE ARE OBJECTS AND NOT FILES ON DISK. A tree is planted into a fresh
// temporary directory by the harness and removed when the case that read it ends, so
// nothing here is ever written into the repository; `apps/desktop/AGENTS.md`'s
// temporary-directory rule is the harness's to keep, and these are its input.

/** One planted tree: every module's path under `src/renderer/src/console/`, and its text. */
export type PlantedTree = Readonly<Record<string, string>>;

/**
 * The shape the console has AFTER this change, reduced to the modules the rules can
 * see.
 *
 * Every member is here because a rule could misfire on it: the sub-module door that
 * must stay legal, the family door that must reach past it to the declaring module,
 * the composition site that imports a family door for a type in its signature, and
 * two view families that mind their own business.
 *
 * THE PANE BOARD IS ONE FILE AND IT IMPORTS A DOOR. It held a pane BODY under a
 * kind directory here until the bodies moved into the families that own them, and
 * the tree it planted was clean only because the deep-import rule subtracted the
 * board at its SOURCE end — the subtraction the two cases at the foot of this file
 * now plant against.
 */
export const CLEAN_TREE: PlantedTree = {
  "core/refusal.ts": `export interface ConsoleRefusal {\n  readonly code: string;\n}\n`,
  "core/index.ts": `export type { ConsoleRefusal } from "./refusal.js";\n`,
  "bridge/growth-values/sessions.ts": `export interface GrowthSessionSummary {\n  readonly sessionId: string;\n}\n`,
  "bridge/growth-values/index.ts": `export type { GrowthSessionSummary } from "./sessions.js";\n`,
  "bridge/growth-signatures.ts": `import type { GrowthSessionSummary } from "./growth-values/index.js";\n\nexport type SessionDirectoryReply = readonly GrowthSessionSummary[];\n`,
  "bridge/index.ts": `export type { GrowthSessionSummary } from "./growth-values/sessions.js";\nexport type { SessionDirectoryReply } from "./growth-signatures.js";\n`,
  "seats/pane-address.ts": `export interface ConsolePaneRegistry {\n  readonly size: number;\n}\n`,
  "seats/surface-registry.ts": `export interface ConsoleSurfaceContext {\n  readonly slot: string;\n}\n`,
  "seats/index.ts": `export type { ConsolePaneRegistry } from "./pane-address.js";\nexport type { ConsoleSurfaceContext } from "./surface-registry.js";\n`,
  "frame/session-lifecycle.ts": `export interface ActiveSession {\n  readonly sessionId: string;\n}\n`,
  "frame/index.ts": `export type { ActiveSession } from "./session-lifecycle.js";\n`,
  "panes/index.ts": `import type { ConsolePaneRegistry } from "../seats/index.js";\n\nexport function registerConsolePanes(registry: ConsolePaneRegistry): number {\n  return registry.size;\n}\n`,
  "collaboration/SentInvites.ts": `import type { ConsoleRefusal } from "../core/index.js";\nimport type { ConsoleSurfaceContext } from "../seats/index.js";\n\nexport type InviteRefusal = ConsoleRefusal & { readonly context: ConsoleSurfaceContext };\n`,
  "repos/RepoList.ts": `import type { ConsoleRefusal } from "../core/index.js";\n\nexport type RepoRefusal = ConsoleRefusal;\n`,
  "repos/index.ts": `export type { RepoRefusal } from "./RepoList.js";\n`,
};

/** The forward this change removed: a family door reaching another door instead of a module. */
export const BARREL_CHAIN_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "bridge/index.ts": `export type { GrowthSessionSummary } from "./growth-values/index.js";\nexport type { SessionDirectoryReply } from "./growth-signatures.js";\n`,
};

/**
 * The sibling edge the r9 rule set left green: one view family reaching another.
 *
 * Written through the target family's DOOR on purpose, so this tree offends exactly
 * one rule. A deep specifier would offend the door rule as well, and a control that
 * trips two rules cannot say which of them was the one that bit.
 */
export const VIEW_FAMILY_EDGE_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "collaboration/SentInvites.ts": `import type { RepoRefusal } from "../repos/index.js";\n\nexport type InviteRefusal = RepoRefusal;\n`,
};

/**
 * The shape the door rule was added for: a view family reaching a layer family's
 * MODULE, beside the DOOR import it is allowed to write.
 *
 * Both edges leave the same file, which is what makes this one tree two controls: the
 * `frame/session-lifecycle.js` specifier must be reported, and the `seats/index.js`
 * door import — carried over from the clean tree — must not. One edge alone would
 * prove only that the rule fires, not that it leaves the legal shape alone.
 *
 * A THIRD edge carries what used to be the rule's one named exemption. While the
 * surface registry lived in `frame/`, `frame/surface-registry.ts` was subtracted from
 * this rule's targets by name — a view family needs it and cannot import the frame's
 * door — so a deep specifier to it was reported as nothing. The module now lives in
 * `seats/`, the family whose contracts it is one of; the subtraction is gone, and a
 * deep specifier to it is an ordinary violation. That is the claim the third import
 * plants: the rule covers the whole console with no module exempted by name.
 */
export const DEEP_IMPORT_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "collaboration/SentInvites.ts": `import type { ConsoleRefusal } from "../core/index.js";\nimport type { ConsoleSurfaceContext } from "../seats/index.js";\nimport type { ConsoleSurfaceContext as DeepContext } from "../seats/surface-registry.js";\nimport type { ActiveSession } from "../frame/session-lifecycle.js";\n\nexport type InviteRefusal = ConsoleRefusal & {\n  readonly context: ConsoleSurfaceContext;\n  readonly deep: DeepContext;\n  readonly session: ActiveSession;\n};\n`,
};

/**
 * A sub-module door reached from OUTSIDE its family, which `apps/desktop/AGENTS.md`
 * says is not a sub-module door at all.
 *
 * The exemption in the rule matches a family door's single path segment, so this
 * nested `index.ts` is not admitted by it — the claim this tree checks, since a
 * regular expression written one segment looser would let any family publish a second
 * door to the rest of the console.
 */
export const SUB_MODULE_DOOR_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "repos/RepoList.ts": `import type { GrowthSessionSummary } from "../bridge/growth-values/index.js";\n\nexport type RepoRefusal = GrowthSessionSummary;\n`,
};

/**
 * A pane BODY parked under the composition site, planted from BOTH endpoints.
 *
 * The body has its own outgoing edge and the board imports it, because these rules
 * match EDGES rather than directories: a body that imported nothing at all — a table,
 * a closed set — would be reported by neither its own outgoing edges nor the orphan
 * rule, since the board importing it gives it a dependent.
 *
 * The body reaches for another VIEW family rather than for a layer, and that is the
 * second claim: under the board's old directory-wide exemption this edge was
 * subtracted from the sibling-isolation rule on both endpoints and passed in silence.
 * It reaches a MODULE rather than that family's door, which is the third: a body under
 * the board is an ordinary view family in every respect, so the door rule holds it to
 * the same specifier discipline as `repos/` or `collaboration/`.
 */
export const PANE_BOARD_SUBDIRECTORY_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "panes/runs/RunsPaneBody.ts": `import type { RepoRefusal } from "../../repos/RepoList.js";\n\nexport type RunsPaneRefusal = RepoRefusal;\n`,
  "panes/index.ts": `import type { ConsolePaneRegistry } from "../seats/index.js";\nimport type { RunsPaneRefusal } from "./runs/RunsPaneBody.js";\n\nexport function registerConsolePanes(registry: ConsolePaneRegistry): number {\n  const refusal: RunsPaneRefusal | undefined = undefined;\n  return refusal === undefined ? registry.size : 0;\n}\n`,
};

/**
 * The edge the deep-import rule's own source-end subtraction used to hide.
 *
 * FLAT, so the rule above does not fire and this tree offends exactly one rule. The
 * console carried eleven specifiers of this shape while the subtraction stood, every
 * one of them reaching a view family's projection or refusal helpers past its door,
 * and the rule that was added to catch them reported none of them.
 */
export const PANE_BOARD_DEEP_IMPORT_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "panes/pane-chrome.ts": `import type { InviteRefusal } from "../collaboration/SentInvites.js";\n\nexport type PaneRefusal = InviteRefusal;\n`,
};

/**
 * The clean shape again under a FRESH identity, for the cleanup proof below.
 *
 * A distinct object rather than one of the three above, because the memo answers a
 * tree a case has already named without planting anything — so a proof about planting
 * has to be the case that plants. Clean, so it asserts the same nothing the first case
 * does and adds no second claim about the rules.
 */
export const PROOF_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "core/clock.ts": `export const NOW = 0;\n`,
};

/**
 * A view family's SUB-DIRECTORY reaching a layer family's module, past that door.
 *
 * The shape found in production and cruised clean before this rule existed: a pane body
 * two directories deep inside its family reaching `bridge/node-state-read.js` rather
 * than `bridge/index.js`. Planted beside the family-root case because the source's DEPTH
 * is the thing that could be got wrong — the rule captures the owning family from the
 * first path segment, so a source one directory deeper has to resolve to the same owner
 * and be held to the same target set.
 */
export const DEEP_SOURCE_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "repos/pane/node-presence-model.ts": `import type { GrowthSessionSummary } from "../../bridge/growth-signatures.js";\n\nexport type PresentNode = GrowthSessionSummary;\n`,
};

/**
 * The door rule's ONE subtraction, planted so that widening it goes red.
 *
 * `.test-support.*` is subtracted from the door rule alone — a harness reaches for the
 * symbols a door deliberately does not publish, and the barrel census fails a door line
 * whose only reader is a test, so without the subtraction the module class has no legal
 * form. The subtraction was the one arm of this rule set with no failing control, which
 * means a pattern widened by one character would exempt every module in the console and
 * nothing would go red.
 *
 * TWO MODULES WRITE THE SAME EDGE, and that is what makes this discriminating rather
 * than a restatement: the harness is exempt and the ordinary module beside it is not, so
 * a subtraction that stopped being narrow takes the ordinary module's violation with it
 * and this control fails. One module alone would prove only that the exemption exists.
 */
export const TEST_SUPPORT_SUBTRACTION_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "repos/fixtures.test-support.ts": `import type { ActiveSession } from "../frame/session-lifecycle.js";\n\nexport type SeededSession = ActiveSession;\n`,
  "repos/RepoList.ts": `import type { ActiveSession } from "../frame/session-lifecycle.js";\n\nexport type RepoRefusal = ActiveSession;\n`,
};

/**
 * A harness in a LOW family reaching a family above it, beside an ordinary module
 * writing the identical edge.
 *
 * THE CLASS THE DOOR RULE'S SUBTRACTION MUST NOT REACH. `.test-support.*` is
 * subtracted from `console-cross-family-deep-import` and from nothing else, and the
 * tree above proves that subtraction exists. This one proves where it stops: the
 * family ORDERING has no such subtraction, because a harness reaching upward is the
 * same inversion an ordinary module's edge is — the symbol it wants lives above the
 * family that needs it, and the remedy is to hoist the symbol rather than to exempt
 * the reader. `crossMacrotaskBoundary` was exactly this shape in production: a timing
 * helper parked in `bridge/fixture/fixture-bridge.test-support.ts` that `store/` and
 * `frame/` suites both waited on, hoisted by this branch to
 * `core/macrotask-boundary.test-support.ts`.
 *
 * WHY A `.test-support.*` MODULE RATHER THAN THE SUITE THAT FOUND THE DEFECT. The
 * suite is a `.test.tsx`, and `options.exclude` in `.dependency-cruiser.mjs` removes
 * every `.test.(ts|tsx)` from the graph BEFORE any rule runs — deliberately, because
 * a `console-unit` test legitimately reaches across families to drive the module it
 * covers. So the importer that surfaced the mis-homing is invisible to this cruise by
 * design, and the class that is not is the harness beside it, which stays in the
 * graph and is a subject of every ordering rule.
 *
 * THE EDGE IS WRITTEN THROUGH THE DOOR, so this tree offends exactly one rule. A deep
 * specifier would offend the door rule as well on the ordinary module and not on the
 * harness, and a control that trips two rules asymmetrically cannot say which of them
 * bit.
 */
export const TEST_SUPPORT_UPWARD_EDGE_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "store/settle.test-support.ts": `import type { SessionDirectoryReply } from "../bridge/index.js";\n\nexport type SettledDirectory = SessionDirectoryReply;\n`,
  "store/session-directory-store.ts": `import type { SessionDirectoryReply } from "../bridge/index.js";\n\nexport type StoredDirectory = SessionDirectoryReply;\n`,
};

/**
 * A renderer subtree BESIDE the console reaching past a family door.
 *
 * Every other rule here is `from`-scoped to `console/`, so an importer that lives
 * outside it matches none of them — which is how a Tier-1 subtree came to hold a
 * `console/store/subject-scoped-state.js` specifier while three gates reported clean.
 * The door import beside it is the other half of the control: an outside subtree
 * reaching the DOOR is the shape the console offers and must stay legal.
 *
 * A HARNESS WRITES THE OFFENDING EDGE TOO, and is exempt for the reason the
 * intra-console deep-import rule exempts one: a `.test-support` module is part of a
 * suite rather than something that ships, and neither remedy the rule offers is open
 * to it — a door cannot publish a fixture helper (`barrel-census` fails a specifier no
 * production module reads) and there is nowhere below to hoist one to. Three modules,
 * one edge written twice and the legal shape once: a subtraction widened past
 * `.test-support` takes the production violation with it and this control reads an
 * empty list.
 */
export const OUTSIDE_RENDERER_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "../session-bootstrap/SessionBootstrap.ts": `import type { ActiveSession } from "../console/frame/session-lifecycle.js";\n\nexport type BootstrapSession = ActiveSession;\n`,
  "../session-bootstrap/seeded.test-support.ts": `import type { ActiveSession } from "../console/frame/session-lifecycle.js";\n\nexport type SeededBootstrap = ActiveSession;\n`,
  "../session-members/SessionMembers.ts": `import type { RepoRefusal } from "../console/repos/index.js";\n\nexport type MemberRefusal = RepoRefusal;\n`,
};

/**
 * A console ROOT module that is not one of the enumerated composition sites.
 *
 * The root is where a composition lives, and a composition is the one thing that may
 * name more than one view family — so a file that lands there and is not on the list is
 * a family importing a sibling with the isolation rule stepped around. That rule cannot
 * see it: its `from` captures the owning DIRECTORY so it can subtract that family from
 * its own targets, and a root file has no directory to capture.
 *
 * `families.ts` is planted beside it doing the same thing, which is the half that makes
 * the enumeration a claim rather than a ban on root files.
 */
export const CONSOLE_ROOT_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "families.ts": `import type { RepoRefusal } from "./repos/index.js";\n\nexport type FamilyRefusal = RepoRefusal;\n`,
  "rogue-composition.ts": `import type { RepoRefusal } from "./repos/index.js";\n\nexport type RogueRefusal = RepoRefusal;\n`,
};

/**
 * A module that SHIPS importing a `.test-support` sibling, beside a harness doing it.
 *
 * WHAT MAKES THE TEST-SUPPORT SUBTRACTIONS SAFE, planted rather than argued. Two rules
 * subtract `.test-support.*` from their source side, so a production module that
 * imported one would reach whatever that harness reaches with neither of them
 * reporting anything. What closes that is a rule on the edge itself, and this is its
 * control.
 *
 * TWO MODULES WRITE THE SAME EDGE, on the discriminating shape the two trees above
 * take: the ordinary module is reported and the harness beside it is not, so a source
 * subtraction dropped from the rule empties the harness expectation and a subtraction
 * widened to every importer empties the ordinary one.
 *
 * BOTH EDGES ARE INTRA-FAMILY, so this tree offends exactly one rule: a cross-family
 * specifier would trip the door rule as well, on the ordinary module only, and a
 * control that fires two rules asymmetrically cannot say which of them bit.
 */
export const SHIPPING_TEST_SUPPORT_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "store/settle.test-support.ts": `export interface SettledDirectory {\n  readonly settled: boolean;\n}\n`,
  "store/session-directory-store.ts": `import type { SettledDirectory } from "./settle.test-support.js";\n\nexport type StoredDirectory = SettledDirectory;\n`,
  "store/seeded.test-support.ts": `import type { SettledDirectory } from "./settle.test-support.js";\n\nexport type SeededDirectory = SettledDirectory;\n`,
};

/**
 * A VIEW family importing the cross-process leaf, beside a LAYER family doing it.
 *
 * `src/shared/` is not a console family and sits on no rung of the DAG, so every
 * ordering rule is silent about it. The console's own answer is that a layer family
 * owns the shared shape and everything above it reads the console's, and this tree is
 * that answer's control: the two modules write the same edge and only the view
 * family's is reported.
 *
 * THE EDGE LEAVES THE CONSOLE, so the specifier climbs out of the planted root the
 * way `OUTSIDE_RENDERER_TREE`'s does — the harness plants relative to
 * `src/renderer/src/console`, and `src/shared/` is three directories above it.
 */
export const VIEW_FAMILY_SHARED_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "../../../shared/wire-errors.ts": `export interface WireRejection {\n  readonly code: string;\n}\n`,
  "core/wire-rejection.ts": `import type { WireRejection } from "../../../../shared/wire-errors.js";\n\nexport type ConsoleWireRejection = WireRejection;\n`,
  "repos/RepoList.ts": `import type { WireRejection } from "../../../../shared/wire-errors.js";\n\nexport type RepoRefusal = WireRejection;\n`,
};

/**
 * Every tree that carries a rule control — the clean shape and the ones that offend.
 *
 * The aggregate case below reads this rather than naming three of them, so a control
 * added for a further rule joins that case's quantifier by construction. `PROOF_TREE`
 * is deliberately not here: the cleanup case that plants it is the one case whose
 * claim is that no earlier case named it.
 */
export const RULE_CONTROL_TREES: readonly PlantedTree[] = [
  CLEAN_TREE,
  BARREL_CHAIN_TREE,
  VIEW_FAMILY_EDGE_TREE,
  DEEP_IMPORT_TREE,
  SUB_MODULE_DOOR_TREE,
  PANE_BOARD_SUBDIRECTORY_TREE,
  PANE_BOARD_DEEP_IMPORT_TREE,
  DEEP_SOURCE_TREE,
  TEST_SUPPORT_SUBTRACTION_TREE,
  TEST_SUPPORT_UPWARD_EDGE_TREE,
  SHIPPING_TEST_SUPPORT_TREE,
  VIEW_FAMILY_SHARED_TREE,
  OUTSIDE_RENDERER_TREE,
  CONSOLE_ROOT_TREE,
];

/** Every tree this file plants. The memo control bounds the cruise count on it. */
export const EVERY_PLANTED_TREE: readonly PlantedTree[] = [...RULE_CONTROL_TREES, PROOF_TREE];
