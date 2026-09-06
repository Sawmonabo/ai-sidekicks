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
// surface one primary action and puts the rest one click away, so the builder pane's
// head offers saving and nothing else; the other four are reached from the
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
// append rather than a redesign. `unregisteredAuthoringAct` is what a pane with no
// wire renders instead of a button that would do nothing.

import { WIRE_UNREGISTERED_REFUSAL_CODE } from "../../../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import type { ConsoleEntityRef } from "../../../store/index.js";
import type { WorkflowStripState } from "../../strip-state.js";
import { PANE_ADDRESS_INVALID_CODE, misaddressedPane } from "../pane-addressing.js";

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
 * Two members, and they refuse at two different moments. Every shape the canvas
 * refuses is refused at the point it is drawn, in the body's own words at the
 * cursor, and every save-time refusal is the daemon's typed code rendered verbatim
 * — neither of those is here. What is left for this pane is the pair of cases with
 * no daemon in the loop at all:
 *
 *   • `wire-unregistered` — there is a subject and no wire. The question is
 *     well-formed and nothing can be asked, because the operation is not on the
 *     bridge. The bridge owns that code and publishes it, so this set names it from
 *     there for the reason it names the address code from `pane-addressing.ts`.
 *   • `pane-address-invalid` — there is no well-formed question. The pane was
 *     handed an entity of a kind it does not author, so it refuses BEFORE composing
 *     a read rather than passing a run id off as a definition id and asking about
 *     something that does not exist. Both panes in this family raise it, so the code
 *     itself is declared in `workflows/pane/pane-addressing.ts` and this set names it from
 *     there rather than spelling a second literal.
 */
export const WORKFLOW_BUILDER_REFUSAL_CODES: readonly [
  typeof WIRE_UNREGISTERED_REFUSAL_CODE,
  typeof PANE_ADDRESS_INVALID_CODE,
] = [WIRE_UNREGISTERED_REFUSAL_CODE, PANE_ADDRESS_INVALID_CODE] as const;

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
  const code: WorkflowBuilderRefusalCode = WIRE_UNREGISTERED_REFUSAL_CODE;
  return refuse(
    WORKFLOW_BUILDER_ORIGIN,
    code,
    `${ACT_PROSE[act]} is not reachable from this build — the operation is not on the bridge yet.`,
  );
}

/**
 * The one entity kind this pane authors.
 *
 * `CONSOLE_ENTITY_KINDS` registers `workflow-definition` and `workflow-run` as two
 * kinds on purpose — a definition is authored, versioned and scoped and outlives
 * every run of it — and this surface edits the first. A binding rather than a
 * literal at the guard, so the kind the pane accepts and the kind its refusal names
 * cannot come apart.
 */
export const WORKFLOW_BUILDER_SUBJECT_KIND: ConsoleEntityRef["kind"] = "workflow-definition";

/**
 * The state of a pane handed an entity it does not author.
 *
 * REFUSED AND NEVER THROWN, and never quietly read either. Both of the other
 * dispositions are worse than this one: a throw takes the whole deck down over one
 * mis-addressed pane, and treating any id as a definition id is what this guard
 * replaces — the pane would compose a read for a definition that does not exist and
 * present whatever came back as the definition a person asked to edit.
 *
 * The sentence is `workflows/pane/pane-addressing.ts`'s, bound here to this surface's
 * origin and to the one kind it authors: the run view raises the same refusal about
 * its own kind, and two copies of one sentence are two sentences the day either is
 * reworded.
 */
export function misaddressedBuilderPane(addressedKind: ConsoleEntityRef["kind"]): ConsoleRefusal {
  return misaddressedPane(WORKFLOW_BUILDER_ORIGIN, WORKFLOW_BUILDER_SUBJECT_KIND, addressedKind);
}

/**
 * The state of a pane opened with no definition to author.
 *
 * `empty` and not `not-checked`: nothing was left unasked here, because there is no
 * subject to ask about. `strip-state.ts` reserves this arm for exactly that — a
 * surface whose address names no subject at all — and the two absences point at
 * different next moves, which is why they are different arms.
 *
 * WHY THIS IS AN ABSENCE AND NOT AN AUTHORING CANVAS. Every act that writes a
 * definition submits a definition body, and no such operation is on the bridge; the
 * pane can therefore be opened with no subject and can do nothing with one. The
 * surface that would have opened it withholds the control, and this arm is what a
 * pane addressed that way anyway says about itself, rather than a list from which
 * nothing can advance.
 */
export function unaddressedBuilderPane(): WorkflowStripState {
  return {
    kind: "empty",
    title: "This pane was opened without a definition to author.",
    detail: `${ACT_PROSE[WORKFLOW_BUILDER_PRIMARY_ACT]} is not reachable from this build, so nothing here can start one. Open a definition from the workflows destination to edit an existing one.`,
  };
}
