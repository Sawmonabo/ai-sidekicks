// What the definitions list and its row are made of.
//
// A LEAF BECAUSE SEVERAL MODULES READ IT. The directory hook holds rows and
// `DefinitionListItem.tsx` draws one — and declaring the shape in either would make the
// other import from a component or hook module. This module is the ONE home: every
// reader of `WorkflowDefinitionRow` imports it from here, and no component module
// re-exports it, which is what keeps one shape from having two apparent homes.

import type { WorkflowDefinitionSummary } from "@renderer/services/wire-shapes/workflow-projection.js";

/**
 * One definition, as the enumeration carries it.
 *
 * The list draws three of it — the name, the scope and the latest version — and carries
 * the whole row anyway, because a row is the value a caller passes to whatever opens the
 * detail: trimming it here would force that caller into a second read for facts it
 * already held. What each member MEANS is documented once, on the wire declaration this
 * alias names.
 */
export type WorkflowDefinitionRow = WorkflowDefinitionSummary;

/** What a row's open control does, when a caller supplies one. */
export type OpenDefinition = (definition: WorkflowDefinitionRow) => void;
