// The definitions this session can start, read once and read whole.
//
// ONE ENUMERATION DOOR, TWO READERS. The accelerator resolves a typed name against
// this list, and the discovery surface offers candidates from it while the name is
// still being typed. Written twice they would be two reads of one wire that answer
// two different questions about one line — and the surface that offered a candidate
// would stop agreeing with the path that starts it the first time either side's
// paging or filtering was tuned.
//
// THE READ FOLLOWS `nextCursor` TO EXHAUSTION. `workflow.definitionList` is cursor
// paged, so a resolution matching only the first page reported "no workflow by that
// name" for every definition past it — a refusal about a name the daemon does carry.
// The walk is BOUNDED: a cursor the daemon keeps handing back would otherwise be an
// unbounded loop on a person's keystroke, so the page count is capped and a read that
// hits the cap answers `complete: false` rather than claiming a finished search. The
// caller that renders it says what an incomplete list cannot support, exactly as the
// provider enumeration does with a truncated group.
//
// AND IT IS CANCELLABLE WITHOUT A SECOND MECHANISM. The console's read chokepoint is
// the subject-scoped holder: an answer published for a subject the surface has left
// writes nowhere. The walk takes the same guard as a predicate, so a superseded read
// stops asking for pages as well as dropping the answer it already has — the pages it
// would fetch are pages nobody can be shown.

import {
  settleGrowthRead,
  type GrowthPort,
  type SettledReadRefusal,
  type WorkflowDefinitionSummary,
} from "../../../../console/bridge/index.js";
import { COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP } from "../../composer-bounds.js";

/** What one walk of the enumeration settled as. */
export type WorkflowDefinitionEnumeration =
  | {
      readonly status: "served";
      readonly definitions: readonly WorkflowDefinitionSummary[];
      /**
       * False when the page cap stopped the walk before the daemon ran out of
       * cursors, so a caller never reports an empty search over a partial list.
       */
      readonly complete: boolean;
    }
  | { readonly status: "refused"; readonly refusal: SettledReadRefusal };

/** One page's request, derived from the port so nothing here restates its shape. */
type WorkflowDefinitionListRequest = Parameters<GrowthPort["workflowDefinitionList"]>[0];

/** Whether the reading this walk is for is still the one on screen. */
export type WorkflowEnumerationLiveness = () => boolean;

/** The walk is always live where no caller supplies a liveness predicate. */
const ALWAYS_LIVE: WorkflowEnumerationLiveness = () => true;

/**
 * Read every definition this session can start, following the wire's own cursor.
 *
 * A plain function rather than a hook, so the accelerator's dispatch and the
 * discovery surface's candidate source spend ONE implementation: the dispatch has no
 * React tree to read from, and a hook-shaped door would have forced it to grow a
 * second walk beside this one.
 *
 * A refusal on ANY page is the whole read's refusal, carried with its own code: a
 * partial list presented as the answer would resolve a name against definitions the
 * daemon never finished listing.
 */
export async function readWorkflowDefinitions(
  growth: GrowthPort,
  sessionId: string,
  isLive: WorkflowEnumerationLiveness = ALWAYS_LIVE,
): Promise<WorkflowDefinitionEnumeration> {
  const definitions: WorkflowDefinitionSummary[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP; page += 1) {
    if (!isLive()) {
      // Superseded between pages. The answer has nowhere to go, so the walk stops
      // asking rather than spending the remaining pages to publish nothing.
      return { status: "served", definitions, complete: false };
    }
    // The request is typed off the PORT rather than left to inference: the cursor is
    // read out of the previous page's reply and written back into the next page's
    // request, and an inferred literal makes that loop circular to the checker.
    const request: WorkflowDefinitionListRequest =
      cursor === undefined ? { sessionId } : { sessionId, cursor };
    const settled = await settleGrowthRead(growth.workflowDefinitionList(request));
    if (settled.status !== "served") {
      return { status: "refused", refusal: settled };
    }
    definitions.push(...settled.value.definitions);
    cursor = settled.value.nextCursor;
    if (cursor === undefined) {
      return { status: "served", definitions, complete: true };
    }
  }
  // The cap stopped the walk with a cursor still outstanding: what is held is a real
  // partial list, and saying so is what keeps a caller from reporting a finished
  // search over it.
  return { status: "served", definitions, complete: false };
}
