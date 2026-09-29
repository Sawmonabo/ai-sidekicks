// The builder pane's address vocabulary: the one entity kind it authors, and what it says
// when it is opened with no subject or with the wrong kind.

import type { ConsoleRefusal } from "@renderer/lib/refusal.js";
import type { ConsoleEntityRef } from "@renderer/lib/entity-kinds.js";
import type { WorkflowStripState } from "../strip-state.js";
import { misaddressedPane } from "../pane-addressing.js";

/** The subsystem name every refusal raised in this file carries. */
export const WORKFLOW_BUILDER_ORIGIN = "workflow-builder";

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
 */
export function unaddressedBuilderPane(): WorkflowStripState {
  return { kind: "empty", title: "This pane was opened without a definition to author." };
}
