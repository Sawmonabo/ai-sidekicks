// Which run a wire payload names. Its subject is the contracts package's registered payload
// shapes, not the projection: it reads an open record and answers with a run id or nothing.

import { TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS } from "@ai-sidekicks/contracts";

/**
 * Reads the run a payload belongs to, or `undefined` where it belongs to none.
 *
 * The members read are the contract's own list, `runId` and `targetRunId`: interventions name
 * the run `targetRunId`, so reading only `runId` would project every `intervention.*` event as a
 * session-level `general` row outside its run group. A member naming another run
 * (`parentRunId`, `workflowRunId`, `holderRunId`) is not in that list, so a child's rows are
 * never filed in its parent's group.
 *
 * Takes the open record, not an event, so this module stays free of the store's projection
 * contract; members are `unknown` there, so the string is checked.
 */
export function attributedRunIdOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  for (const member of TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS) {
    const candidate = payload?.[member];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}
