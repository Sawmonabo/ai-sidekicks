// What the definitions browser and its two row surfaces are made of.
//
// A LEAF BECAUSE THREE MODULES READ IT. `DefinitionsBrowser.tsx` groups rows,
// `DefinitionScopeGroup.tsx` holds one scope's, and `DefinitionListItem.tsx` draws
// one — and declaring the shape in any of the three would make the other two import
// from a component module and, for the browser, close a cycle the layering gate
// rejects. This module is the ONE home: every reader of `WorkflowDefinitionRow`
// imports it from here, and the family door publishes it from here too — no component
// module re-exports it, which is what keeps one shape from having two apparent homes.

import type { WorkflowDefinitionSummary } from "../../bridge/index.js";

/**
 * One definition, as the enumeration carries it.
 *
 * The list draws four of it — the name, the scope, the latest version, and the
 * resolution mark — and carries the whole row anyway, because a row is the value a
 * caller passes to whatever opens the detail: trimming it here would force that
 * caller into a second read for facts it already held. What each member MEANS is
 * documented once, on the wire declaration this alias names.
 */
export type WorkflowDefinitionRow = WorkflowDefinitionSummary;

/** What a row's open control does, when a caller supplies one. */
export type OpenDefinition = (definition: WorkflowDefinitionRow) => void;
