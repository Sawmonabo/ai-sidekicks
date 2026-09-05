// The three wire calls a resolved send makes, and how each one settles.
//
// Split from `send-router.ts` because resolution and dispatch are two different
// jobs with two different failure modes. Resolution is pure — it reads text and a
// target and answers what WOULD happen — while everything here has already left the
// process and is reading what came back. Keeping them in one module made the router
// a file where half the reader's questions ("can this text be sent?") and the other
// half ("did it arrive?") were answered in the same breath.
//
// THREE PATHS RATHER THAN ONE WITH A FLAG, because the three settle differently and
// a flag would have made that a branch nobody sets. `driver.interruptRun` answers
// with `DriverAckResult`, declared as the empty object, so its SERVED reply is the
// settlement and there is no member to read. `run.queueCreate` answers with a queued
// item whose shape is the confirmation. And `run.intervene` answers with a LIFECYCLE
// STATE that may say the run declined the message — a served reply that is still not
// a delivered directive.
//
// EVERY REPLY IS PARSED BEFORE ANYTHING IS READ OFF IT. That is the call door's
// doing rather than this module's, in both directions: a request that does not match
// its registered shape never leaves, and a reply that does not match refuses instead
// of being read. What this module adds is the settlement each parsed reply means.

import type {
  InterruptRunParams,
  InterventionRequestPayload,
  InterventionState,
  QueueItemCreateRequest,
} from "@ai-sidekicks/contracts";

import { callDaemon, type ConsoleBridge } from "../../../console/bridge/index.js";
import { interventionNotApplied } from "./send-refusals.js";
import type { ComposerSendOutcome } from "./send-resolutions.js";
import type { RunVersionLedger } from "./run-version-ledger.js";

/**
 * Dispatch the stop, whose SERVED reply IS the settlement.
 *
 * The one send path with nothing to read OFF the reply, and that is its CONTRACT
 * rather than a shortcut: the registered `DriverAckResult` is the empty object, so
 * there is no member a settlement could branch on. The reply is still parsed — the
 * door parses every one — and a shape carrying members is a protocol mismatch this
 * path refuses rather than reads as a stop that happened.
 */
export async function dispatchInterrupt(
  bridge: ConsoleBridge,
  params: InterruptRunParams,
): Promise<ComposerSendOutcome> {
  const reply = await callDaemon(bridge, "driver.interruptRun", params);
  return reply.status === "refused"
    ? { status: "refused", refusal: reply.refusal }
    : { status: "sent", path: "provider-bound" };
}

/**
 * Dispatch one new turn, and READ what came back.
 *
 * `run.queueCreate` answers with the registered `QueueItemCreateResponse` — the
 * item's id, its state, and when it was created — so a reply that is not that shape
 * is a reply this console can read no queued message out of, which is what a
 * protocol-version mismatch produces. Returning it as sent would clear the
 * participant's draft on the strength of a payload nothing had understood.
 *
 * The parsed value is deliberately not KEPT. Nothing in the composer addresses a
 * queue item — the shelf reads the queue from its own subscription — so what the
 * parse buys is the confirmation itself and not a member to carry forward.
 */
export async function dispatchQueuedTurn(
  bridge: ConsoleBridge,
  request: QueueItemCreateRequest,
): Promise<ComposerSendOutcome> {
  const reply = await callDaemon(bridge, "run.queueCreate", request);
  return reply.status === "refused"
    ? { status: "refused", refusal: reply.refusal }
    : { status: "sent", path: "channel-message" };
}

/**
 * Dispatch one steer, and READ what came back.
 *
 * The version is kept from EVERY parsed response — a refusal answers with the run's
 * current version too, which is what lets the next attempt guard itself without a
 * re-read the console has no projection to perform.
 */
export async function dispatchIntervention(
  bridge: ConsoleBridge,
  request: InterventionRequestPayload,
  runVersions: RunVersionLedger,
): Promise<ComposerSendOutcome> {
  const reply = await callDaemon(bridge, "run.intervene", request);
  if (reply.status === "refused") {
    return { status: "refused", refusal: reply.refusal };
  }
  runVersions.record(request.targetRunId, reply.value.runVersion);
  if (!isInterventionAdmitted(reply.value.state)) {
    return {
      status: "refused",
      refusal: interventionNotApplied(reply.value.state, reply.value.rejectionReason),
    };
  }
  return { status: "sent", path: "provider-bound" };
}

/**
 * Whether an intervention state means the composed text reached the run.
 *
 * A total switch over the registered union rather than a list, so a seventh state
 * has to be classified rather than falling into whichever arm was written last.
 * `Queue And Intervention Model §Intervention State Transition Table` is what
 * decides each one: `requested` and `accepted` are admissions the daemon will act
 * on, `applied` is the provider confirming the effect, and `degraded` is the
 * orchestration layer having fallen back — the message travelled on all four. Only
 * `rejected` (refused before dispatch) and `expired` (the version guard, or the run
 * moving between accept and apply) leave the participant's words unsent, and those
 * are the two that keep the draft.
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
