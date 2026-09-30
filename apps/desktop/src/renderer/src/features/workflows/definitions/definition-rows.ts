// What the definitions list and its row are made of. A leaf because the directory hook and
// `DefinitionListItem.tsx` both read `WorkflowDefinitionRow`; declaring it in either would make
// the other import from a component or hook module.

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts";

/**
 * One definition, as the enumeration carries it. The list draws three fields but the row stays
 * whole, since it is the value a caller passes to open the detail. Member meanings are
 * documented on the wire declaration this aliases.
 */
export type WorkflowDefinitionRow = WorkflowDefinitionSummary;

/** What a row's open control does, when a caller supplies one. */
export type OpenDefinition = (definition: WorkflowDefinitionRow) => void;
