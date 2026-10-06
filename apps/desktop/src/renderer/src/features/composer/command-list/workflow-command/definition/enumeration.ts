// Every saved workflow, read whole. The line handler resolves a typed name
// against this list and the command list offers candidates from it, so one walk keeps the
// two agreeing. `workflow.definitionList` is cursor paged and the walk follows `nextCursor`, capped
// at a page count so a cursor that never ends cannot loop; a capped read answers
// `complete: false`. The page read is an argument: this module holds the walk, not the wire.

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";
import { COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP } from "#renderer/features/composer/bounds.js";

/** What one walk of the enumeration read. */
export interface WorkflowDefinitionEnumeration {
  readonly definitions: readonly WorkflowDefinitionSummary[];
  /**
   * False when the page cap stopped the walk before the daemon ran out of
   * cursors, so a caller never reports an empty search over a partial list.
   */
  readonly complete: boolean;
}

/** One page of definitions and the cursor to the next, absent on the last. */
export interface WorkflowDefinitionPage {
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly nextCursor: string | undefined;
}

/** Reads one page of the saved workflows. */
export type ReadWorkflowDefinitionPage = (request: {
  readonly cursor?: string;
}) => Promise<WorkflowDefinitionPage>;

/** Whether the reading this walk is for is still the one on screen. */
export type WorkflowEnumerationLiveness = () => boolean;

/** The walk is always live where no caller supplies a liveness predicate. */
const ALWAYS_LIVE: WorkflowEnumerationLiveness = () => true;

/**
 * Read every saved workflow, following the wire's own cursor. A page read
 * that rejects rejects the whole walk, since a partial list would resolve a name against
 * definitions the daemon never finished listing. `isLive` stops the walk between pages.
 */
export async function readWorkflowDefinitions(
  readPage: ReadWorkflowDefinitionPage,
  isLive: WorkflowEnumerationLiveness = ALWAYS_LIVE,
): Promise<WorkflowDefinitionEnumeration> {
  const definitions: WorkflowDefinitionSummary[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP; page += 1) {
    if (!isLive()) {
      // Superseded between pages: stop asking rather than fetch pages nobody can be shown.
      return { definitions, complete: false };
    }
    const reply = await readPage(cursor === undefined ? {} : { cursor });
    definitions.push(...reply.definitions);
    cursor = reply.nextCursor;
    if (cursor === undefined) {
      return { definitions, complete: true };
    }
  }
  // The cap stopped the walk with a cursor outstanding, so the list is partial.
  return { definitions, complete: false };
}
