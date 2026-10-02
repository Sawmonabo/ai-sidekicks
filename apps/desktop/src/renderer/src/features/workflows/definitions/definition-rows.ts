// What a definitions list row's open control does, in a leaf module so the list that supplies it
// and `DefinitionListItem.tsx` that calls it need not import each other.

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts";

/** What a row's open control does, when a caller supplies one. */
export type OpenDefinition = (definition: WorkflowDefinitionSummary) => void;
