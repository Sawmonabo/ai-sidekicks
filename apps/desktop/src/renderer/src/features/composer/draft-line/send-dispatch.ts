// The two wire calls a resolved send makes, and how each reply settles. The calls are supplied
// by the caller, so this module reaches no bridge and a rejected call propagates.
//
// The paths differ: `run.queueCreate` answering is the confirmation, while `run.intervene`
// answers with a lifecycle state that may say the run declined the message.

import type {
  InterventionRequestPayload,
  InterventionRequestResponse,
  InterventionState,
  QueueItemCreateRequest,
  QueueItemCreateResponse,
} from "@ai-sidekicks/contracts";

import { interventionNotApplied } from "./send-refusals.js";
import type { ComposerSendOutcome } from "./send-resolutions.js";
import type { AnsweredRunVersions } from "../answered-run-versions.js";

/** The two daemon calls a send makes, supplied by whoever holds the wire. */
export interface ComposerSendCalls {
  queueCreate(request: QueueItemCreateRequest): Promise<QueueItemCreateResponse>;
  intervene(request: InterventionRequestPayload): Promise<InterventionRequestResponse>;
}

/**
 * Dispatch one new turn. The queued item is not kept: the transcript's queued rows read the
 * queue from their own subscription, so the answer is only the confirmation.
 */
export async function dispatchQueuedTurn(
  calls: ComposerSendCalls,
  request: QueueItemCreateRequest,
): Promise<ComposerSendOutcome> {
  await calls.queueCreate(request);
  return { status: "sent", path: "session-message" };
}

/**
 * Dispatch one steer and read what came back. The run version is kept from every response,
 * a rejected one included, so the next attempt is guarded without a re-read.
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
 * Whether an intervention state means the composed text reached the run. Total over the
 * union, so a new state must be classified. `requested`, `accepted`, `applied` and `degraded`
 * all delivered the message; `rejected` and `expired` did not, and keep the draft.
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
