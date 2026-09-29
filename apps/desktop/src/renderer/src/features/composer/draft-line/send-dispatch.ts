// The two wire calls a resolved send makes, and how each one settles.
//
// Split from `send-router.ts` because resolution and dispatch are two different
// jobs with two different failure modes. Resolution is pure — it reads text and a
// target and answers what WOULD happen — while everything here has already left the
// process and is reading what came back. Keeping them in one module made the router
// a file where half the reader's questions ("can this text be sent?") and the other
// half ("did it arrive?") were answered in the same breath.
//
// TWO PATHS RATHER THAN ONE WITH A FLAG, because the two settle differently and a
// flag would have made that a branch nobody sets. `run.queueCreate` answers with a
// queued item, which is the confirmation. And `run.intervene` answers with a
// LIFECYCLE STATE that may say the run declined the message — an answer that is
// still not a delivered directive.
//
// THE CALLS ARE AN ARGUMENT. Whoever holds the wire supplies `queueCreate` and
// `intervene` as one `ComposerSendCalls`, so this module reaches no bridge, catches
// nothing, and a rejected call propagates to the caller of the send. What this module
// adds is the settlement each reply means.

import type {
  InterventionRequestPayload,
  InterventionRequestResponse,
  InterventionState,
  QueueItemCreateRequest,
  QueueItemCreateResponse,
} from "@ai-sidekicks/contracts";

import { interventionNotApplied } from "./send-refusals.js";
import type { ComposerSendOutcome } from "./send-resolutions.js";
import type { AnsweredRunVersions } from "./answered-run-versions.js";

/** The two daemon calls a send makes, supplied by whoever holds the wire. */
export interface ComposerSendCalls {
  queueCreate(request: QueueItemCreateRequest): Promise<QueueItemCreateResponse>;
  intervene(request: InterventionRequestPayload): Promise<InterventionRequestResponse>;
}

/**
 * Dispatch one new turn.
 *
 * The queued item is deliberately not KEPT. Nothing in the composer addresses a
 * queue item — the shelf reads the queue from its own subscription — so the answer
 * is the confirmation itself and not a member to carry forward.
 */
export async function dispatchQueuedTurn(
  calls: ComposerSendCalls,
  request: QueueItemCreateRequest,
): Promise<ComposerSendOutcome> {
  await calls.queueCreate(request);
  return { status: "sent", path: "session-message" };
}

/**
 * Dispatch one steer, and READ what came back.
 *
 * The version is kept from EVERY response — a `rejected` response carries the run's
 * current version too, which is what lets the next attempt guard itself without a
 * re-read the console has no projection to perform.
 */
export async function dispatchIntervention(
  calls: ComposerSendCalls,
  request: InterventionRequestPayload,
  runVersions: AnsweredRunVersions,
): Promise<ComposerSendOutcome> {
  const response = await calls.intervene(request);
  runVersions.record(request.targetRunId, response.runVersion);
  if (!isInterventionAdmitted(response.state)) {
    return {
      status: "refused",
      refusal: interventionNotApplied(response.state, response.rejectionReason),
    };
  }
  return { status: "sent", path: "provider-bound" };
}

/**
 * Whether an intervention state means the composed text reached the run.
 *
 * A total switch over the registered union rather than a list, so a seventh state has
 * to be classified rather than falling into whichever arm was written last. The
 * intervention state transitions are what decide each one: `requested` and `accepted`
 * are admissions the daemon will act on, `applied` is the provider confirming the
 * effect, and `degraded` is the orchestration layer having fallen back — the message
 * travelled on all four. Only `rejected` (refused before dispatch) and `expired` (the
 * version guard, or the run moving between accept and apply) leave the user's
 * words unsent, and those are the two that keep the draft.
 */
function isInterventionAdmitted(state: InterventionState): boolean {
  switch (state) {
    case "requested":
    case "accepted":
    case "applied":
    case "degraded":
      return true;
    case "rejected":
    case "expired":
      return false;
  }
}
