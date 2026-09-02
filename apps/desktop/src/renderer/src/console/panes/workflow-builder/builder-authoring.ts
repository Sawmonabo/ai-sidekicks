// The builder's authoring vocabulary: the five acts that write a definition, the one
// this surface draws, and the refusal it renders while none of them can be reached.
//
// FIVE ACTS, ONE WIRE. Saving, cutting a new version, importing, promoting, and
// forking a shared definition into a scope of one's own are five things a person
// does and one thing the daemon is asked — every one of them submits a definition
// body and gets a version back, and the authoring surface mints no operation of its
// own. Enumerating them is what keeps that true: a sixth act that needed a sixth
// method would have to be added here first, in front of a reviewer.
//
// ONE OF THE FIVE IS DRAWN. `Spec-023 §Console Design (Meridian)` rule 7 gives a
// surface one primary action and puts the rest one click away, so the builder's
// chrome offers saving and nothing else; the other four are reached from the
// definitions browser and from the version chain, where the thing they act on is
// already in front of the person.
//
// A MODULE RATHER THAN LITERALS IN THE COMPONENT, for the reason the run pane's own
// control vocabulary gives: the act set and the refusal-code set are CLOSED, and a
// closed set spelled inside a component is a set the next surface re-spells. Each
// producer keeps its own code union and widens into the shared refusal shape at its
// boundary — `core/refusal.ts` says why it cannot be one union for the console.
//
// WIRE STATUS — READ THIS BEFORE WIRING A CALLER. `packages/contracts` registers no
// `workflow.*` method, and the five acts below all submit a definition body, which
// is `workflow.definitionCreate` — deliberately NOT on `console/bridge/growth-port.ts`,
// which carries the read and control operations and no create. So nothing in this
// console can submit a definition at all today, and adding one is a growth-row
// append rather than a redesign. `unregisteredAuthoringAct` is what a chrome with no
// wire renders instead of a button that would do nothing.

import { refuse, type ConsoleRefusal } from "../../core/index.js";

/**
 * Every act that writes a definition, and exactly five.
 *
 * The tuple is the declaration and the union derives from it, so the count claim
 * above is countable at runtime rather than asserted in prose.
 */
export const WORKFLOW_AUTHORING_ACTS = [
  "save",
  "new-version",
  "import",
  "promote",
  "fork",
] as const;

/** One authoring act. Derived from the tuple, never restated. */
export type WorkflowAuthoringAct = (typeof WORKFLOW_AUTHORING_ACTS)[number];

/**
 * The one act this surface draws.
 *
 * A binding rather than a literal at the call site: rule 7's "one primary action"
 * is a property of the surface, and a second component reaching for a different
 * member would be a second primary action arriving without anyone deciding to add
 * one.
 */
export const WORKFLOW_BUILDER_PRIMARY_ACT: WorkflowAuthoringAct = "save";

/** The subsystem name every refusal raised in this file carries. */
export const WORKFLOW_BUILDER_ORIGIN = "workflow-builder";

/**
 * The refusals this surface raises on its own, and no others.
 *
 * One member, deliberately: every shape the canvas refuses is refused at the point
 * it is drawn, in the body's own words at the cursor, and every save-time refusal
 * is the daemon's typed code rendered verbatim. What is left for the chrome is the
 * case where there is no daemon in the loop at all — a wire that does not exist.
 */
export const WORKFLOW_BUILDER_REFUSAL_CODES = ["wire-unregistered"] as const;

/** One locally-raised refusal code. Derived from the tuple, never restated. */
export type WorkflowBuilderRefusalCode = (typeof WORKFLOW_BUILDER_REFUSAL_CODES)[number];

/** What each act is called where a person reads about it not being reachable. */
const ACT_PROSE: Readonly<Record<WorkflowAuthoringAct, string>> = {
  save: "Saving a definition",
  "new-version": "Cutting a new version",
  import: "Importing a definition",
  promote: "Promoting a definition to a wider scope",
  fork: "Forking a shared definition",
};

/**
 * The state an authoring act is in on a build whose bridge does not carry it.
 *
 * "Not checked" and never "denied": nobody put the question to a daemon, so a
 * console that rendered this as a denial would be asserting an adjudication that
 * never happened. The detail names the act in prose rather than naming a method
 * string, because no such method is registered and printing one would be this
 * surface inventing the wire it is reporting the absence of.
 */
export function unregisteredAuthoringAct(act: WorkflowAuthoringAct): ConsoleRefusal {
  // Bound through the closed vocabulary before it reaches `refuse`, whose `code`
  // parameter is a deliberately-wide `string` — `core/refusal.ts` cannot close it
  // without importing every producer and inverting the DAG.
  const code: WorkflowBuilderRefusalCode = "wire-unregistered";
  return refuse(
    WORKFLOW_BUILDER_ORIGIN,
    code,
    `${ACT_PROSE[act]} is not reachable from this build — the operation is not on the bridge yet.`,
  );
}
