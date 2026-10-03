// The run view's address: the one entity kind it opens, and the refusal it renders for any
// other. Its origin is separate from the run controls': this refuses about the pane's own
// address before any operation is considered, so the two are never reported as one.

import type { Refusal } from "@renderer/lib/refusal.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import { misaddressedPane } from "../pane-addressing.js";

/** The subsystem name every refusal raised in this file carries. */
const WORKFLOW_RUN_PANE_ORIGIN = "workflow-run";

/**
 * The one entity kind this pane shows.
 *
 * A definition and a run are separate entity kinds. Bound once so the kind the guard admits
 * and the kind the refusal names cannot come apart.
 */
export const WORKFLOW_RUN_PANE_SUBJECT_KIND: EntityRef["kind"] = "workflow-run";

/**
 * The state of a pane handed an entity whose kind names no run.
 *
 * Without it the pane would carry any kind's `entity.id` into the run read and present
 * whatever came back under an address that never named a run.
 */
export function misaddressedRunPane(addressedKind: EntityRef["kind"]): Refusal {
  return misaddressedPane(WORKFLOW_RUN_PANE_ORIGIN, WORKFLOW_RUN_PANE_SUBJECT_KIND, addressedKind);
}
