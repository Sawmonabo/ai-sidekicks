// The run view's address: the one entity kind it opens, and the refusal it renders
// for any other.
//
// A MODULE RATHER THAN LITERALS IN THE COMPONENT, for `run-controls.ts`'s reason at
// one remove: the kind this pane opens is read twice — once by the guard that admits
// an address and once by the sentence that refuses one — and a component spelling it
// at both sites is a component whose guard and whose message can come apart. The
// refusal itself is composed by `workflows/pane-addressing.ts`, which the builder
// pane raises the same way about the kind IT opens.
//
// A SEPARATE ORIGIN FROM THE RUN CONTROLS, DELIBERATELY. `run-controls.ts` refuses
// about an OPERATION that has no wire; this refuses about the pane's own address
// before any operation is considered. A refusal that surfaces three layers away
// names its author through `origin`, so folding the two under one name would have a
// mis-addressed pane reported as a control that could not be reached.

import type { ConsoleRefusal } from "../../../core/index.js";
import type { ConsoleEntityRef } from "../../../store/index.js";
import { misaddressedPane } from "../../pane-addressing.js";

/** The subsystem name every refusal raised in this file carries. */
const WORKFLOW_RUN_PANE_ORIGIN = "workflow-run";

/**
 * The one entity kind this pane shows.
 *
 * `CONSOLE_ENTITY_KINDS` registers `workflow-definition` and `workflow-run` as two
 * kinds on purpose — a definition is authored, versioned and scoped and outlives
 * every run of it — and this surface shows the second. A binding rather than a
 * literal at the guard, so the kind the pane admits and the kind its refusal names
 * cannot come apart.
 */
export const WORKFLOW_RUN_PANE_SUBJECT_KIND: ConsoleEntityRef["kind"] = "workflow-run";

/**
 * The state of a pane handed an entity whose kind names no run.
 *
 * The alternative this replaces is the one that reads: the pane took `entity.id` off
 * any kind at all, so a definition id addressed here was carried into the run read
 * and whatever came back — a refusal or a snapshot — was presented under an address
 * that never named a run.
 */
export function misaddressedRunPane(addressedKind: ConsoleEntityRef["kind"]): ConsoleRefusal {
  return misaddressedPane(WORKFLOW_RUN_PANE_ORIGIN, WORKFLOW_RUN_PANE_SUBJECT_KIND, addressedKind);
}
