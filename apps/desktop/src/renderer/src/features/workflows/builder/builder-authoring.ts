// The builder pane's address vocabulary: the one entity kind it authors, and what it says
// when it is opened with no subject or with the wrong kind.

import type { Refusal } from "@renderer/lib/refusal.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import type { WorkflowStripState } from "../strip-state.js";
import { misaddressedPane } from "../pane-addressing.js";

/** The subsystem name every refusal raised in this file carries. */
export const WORKFLOW_BUILDER_ORIGIN = "workflow-builder";

/**
 * The one entity kind this pane authors. A binding, not a literal at the guard, so the kind the
 * pane accepts and the kind its refusal names cannot come apart.
 */
export const WORKFLOW_BUILDER_SUBJECT_KIND: EntityRef["kind"] = "workflow-definition";

/**
 * The refusal for a pane handed an entity it does not author: returned, never thrown (a throw
 * would take the pane layout down) and never read as a definition id. The sentence is
 * `misaddressedPane`'s, bound to this pane's origin and kind.
 */
export function misaddressedBuilderPane(addressedKind: EntityRef["kind"]): Refusal {
  return misaddressedPane(WORKFLOW_BUILDER_ORIGIN, WORKFLOW_BUILDER_SUBJECT_KIND, addressedKind);
}

/** The state of a pane opened with no definition to author. */
export function unaddressedBuilderPane(): WorkflowStripState {
  return { kind: "empty", title: "This pane was opened without a definition to author." };
}
