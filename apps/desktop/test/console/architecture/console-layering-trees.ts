// The module trees this tier plants, and nothing that runs over them.
//
// Every constant here is a SUBJECT rather than a claim: a handful of console modules
// written out at the relative paths the layering rules are anchored on, one tree per
// shape a rule has to report or leave alone. The cruise harness and the cases that
// read them are `console-layering-rules.test.ts` beside this file, which is the seam
// the tier already takes for `barrel-census.ts` and `stylesheet-edge-graph.ts`: the
// corpus in a module of its own, the suite that judges it next door.
//
// The split is what keeps either file readable. Four rules need seven trees between
// them, each carrying the paragraph that says which rule it is the control for and
// why it offends exactly one — and a file holding those beside the harness, the
// budgets and the cases was doing two jobs at ~500 lines.
//
// WHY THESE ARE OBJECTS AND NOT FILES ON DISK. A tree is planted into a fresh
// temporary directory by the harness and removed when the case that read it ends, so
// nothing here is ever written into the repository; `apps/desktop/AGENTS.md`'s
// temporary-directory rule is the harness's to keep, and these are its input.

/** One planted tree: every module's path under `src/renderer/src/console/`, and its text. */
export type PlantedTree = Readonly<Record<string, string>>;

/**
 * The shape the console has AFTER this change, reduced to the modules the four rules
 * can see.
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
  "seats/index.ts": `export type { ConsolePaneRegistry } from "./pane-address.js";\n`,
  "frame/surface-registry.ts": `export interface ConsoleSurfaceContext {\n  readonly slot: string;\n}\n`,
  "frame/session-lifecycle.ts": `export interface ActiveSession {\n  readonly sessionId: string;\n}\n`,
  "frame/index.ts": `export type { ActiveSession } from "./session-lifecycle.js";\n`,
  "panes/index.ts": `import type { ConsolePaneRegistry } from "../seats/index.js";\n\nexport function registerConsolePanes(registry: ConsolePaneRegistry): number {\n  return registry.size;\n}\n`,
  "collaboration/SentInvites.ts": `import type { ConsoleRefusal } from "../core/index.js";\nimport type { ConsoleSurfaceContext } from "../frame/surface-registry.js";\n\nexport type InviteRefusal = ConsoleRefusal & { readonly context: ConsoleSurfaceContext };\n`,
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
 * MODULE, beside the one deep specifier the rule exempts by name.
 *
 * Both edges leave the same file, which is what makes this one tree two controls: the
 * `frame/session-lifecycle.js` specifier must be reported, and the exempted
 * `frame/surface-registry.js` specifier — carried over from the clean tree — must not.
 * An exemption written against the family rather than the module would report neither.
 */
export const DEEP_IMPORT_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "collaboration/SentInvites.ts": `import type { ConsoleRefusal } from "../core/index.js";\nimport type { ConsoleSurfaceContext } from "../frame/surface-registry.js";\nimport type { ActiveSession } from "../frame/session-lifecycle.js";\n\nexport type InviteRefusal = ConsoleRefusal & {\n  readonly context: ConsoleSurfaceContext;\n  readonly session: ActiveSession;\n};\n`,
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
 * A pane BODY parked under the composition site, the shape the console shipped until
 * the bodies moved into their families.
 *
 * Its one import is a family DOOR, so the deep-import rule has nothing to say about
 * it and this tree offends exactly one rule — the claim being that the board's
 * flatness is enforced by where a module SITS and not by what it reaches for.
 */
export const NESTED_PANE_BODY_TREE: PlantedTree = {
  ...CLEAN_TREE,
  "panes/workflow-run/WorkflowRunPane.ts": `import type { ConsolePaneRegistry } from "../../seats/index.js";\n\nexport type PaneBoard = ConsolePaneRegistry;\n`,
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
 * Every tree that carries a rule control — the clean shape and the six that offend.
 *
 * The aggregate case below reads this rather than naming three of them, so a control
 * added for a fifth rule joins that case's quantifier by construction. `PROOF_TREE` is
 * deliberately not here: the cleanup case that plants it is the one case whose claim
 * is that no earlier case named it.
 */
export const RULE_CONTROL_TREES: readonly PlantedTree[] = [
  CLEAN_TREE,
  BARREL_CHAIN_TREE,
  VIEW_FAMILY_EDGE_TREE,
  DEEP_IMPORT_TREE,
  SUB_MODULE_DOOR_TREE,
  NESTED_PANE_BODY_TREE,
  PANE_BOARD_DEEP_IMPORT_TREE,
];

/** Every tree this file plants. The memo control bounds the cruise count on it. */
export const EVERY_PLANTED_TREE: readonly PlantedTree[] = [...RULE_CONTROL_TREES, PROOF_TREE];
