// The Claude driver's generic intervention dispatcher.
//
// An intervention type the driver cannot dispatch natively returns a `degraded` result: never a
// thrown error, never a silent no-op. The degraded steer arm writes nothing to the provider, so
// the daemon can queue the steer itself without it being applied twice.
//
// Claude steers degraded because it has no steer control-request subtype in the pinned build, and
// writing the text as an ordinary user frame would start a turn the daemon never admitted.
// `capabilities.ts` declares `steer: false` to match.
//
// Failure polarity, for every arm:
//   * A typed `control_response` error means the provider answered and refused: `degraded`, with
//     no `fallbackAction`, because no fallback is documented for a refused interrupt.
//   * A transport exception (broken pipe, dead process, timeout) propagates; `degraded` asserts
//     the request reached the provider.
//   * No live channel for the target run propagates as `ClaudeSessionUnavailableError`; that is a
//     routing fault, not an unsupported capability.
//
// The caller's `clientIdempotencyKey` has no wire field: the `interrupt` control request carries
// only `{ subtype, cancel_queued }`, and the transport's `request_id` is per-attempt correlation
// state. So the key is not sent, and no field is invented for it.
//
// A cancel whose success payload still lists surviving queued messages (`still_queued`, sent by
// builds with `interrupt_receipt_v1`) has not stopped the run's remaining input, so it degrades.
// A plain interrupt does not: surviving queued messages are what an interrupt leaves by design.

import {
  DriverInterventionResultSchema,
  type ApplyInterventionParams,
  type DriverInterventionResult,
  type RunId,
} from "@ai-sidekicks/contracts";

import { ClaudeSessionUnavailableError, type ClaudeRunChannelLookup } from "./lifecycle.js";

/**
 * The fallback the daemon applies for a steer this provider cannot do natively: queue the steer
 * text and interrupt the running turn. Returned as a hint; the schema bounds its length.
 */
export const CLAUDE_STEER_FALLBACK_ACTION: string = "queue_and_interrupt";

// Key of the uuids of queued user messages that outlived an interrupt. Builds without
// `interrupt_receipt_v1` omit it, so absence means "reported nothing", not "nothing survived".
const CLAUDE_INTERRUPT_RECEIPT_SURVIVOR_KEY = "still_queued";

/**
 * Counts the queued messages the provider reports as having survived an interrupt.
 *
 * Returns 0 for a missing key, null or non-array, because the payload comes from the provider;
 * a build that never promised a receipt must not fail a cancel closed.
 */
function countSurvivingQueuedMessages(payload: Record<string, unknown> | undefined): number {
  const survivors = payload?.[CLAUDE_INTERRUPT_RECEIPT_SURVIVOR_KEY];
  return Array.isArray(survivors) ? survivors.length : 0;
}

/** What the dispatcher needs: a lookup from a run to its live Claude channel. */
export interface ClaudeInterventionDispatcherDependencies {
  readonly channelLookup: ClaudeRunChannelLookup;
}

/** Applies interventions to Claude runs; every arm resolves to a `DriverInterventionResult`. */
export class ClaudeInterventionDispatcher {
  readonly #channelLookup: ClaudeRunChannelLookup;

  constructor(dependencies: ClaudeInterventionDispatcherDependencies) {
    this.#channelLookup = dependencies.channelLookup;
  }

  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    switch (params.type) {
      case "steer": {
        // Answered without resolving the run: the missing native steer is a fact about the
        // driver, not the run, so it holds whether or not a channel is live. Nothing is sent.
        return DriverInterventionResultSchema.parse({
          status: "degraded",
          fallbackAction: CLAUDE_STEER_FALLBACK_ACTION,
        });
      }
      case "interrupt": {
        return await this.#dispatchInterrupt(params.targetRunId, false);
      }
      case "cancel": {
        // Claude has no `cancel` subtype; the interrupt request with `cancelQueued` is the
        // nearest mechanism and keeps queued messages from resuming a canceled run.
        return await this.#dispatchInterrupt(params.targetRunId, true);
      }
      default: {
        return degradeUnroutedInterventionType(params);
      }
    }
  }

  async #dispatchInterrupt(
    targetRunId: RunId,
    cancelQueued: boolean,
  ): Promise<DriverInterventionResult> {
    const channel = this.#channelLookup.findChannelForRun(targetRunId);
    if (channel === undefined) {
      throw new ClaudeSessionUnavailableError("no_live_run", { runId: targetRunId });
    }
    const response = await channel.sendControlRequest({ subtype: "interrupt", cancelQueued });
    if (response.subtype === "error") {
      // No `fallbackAction`: the refusal says nothing about what the daemon should do instead.
      // The key is omitted, not `undefined`, because the envelope is `.strict()` under
      // `exactOptionalPropertyTypes`.
      return DriverInterventionResultSchema.parse({ status: "degraded" });
    }
    if (cancelQueued && countSurvivingQueuedMessages(response.response) > 0) {
      // The provider acknowledged a cancel but reported survivors. No `fallbackAction`: they
      // are already queued, so `queue_and_interrupt` would re-queue them.
      return DriverInterventionResultSchema.parse({ status: "degraded" });
    }
    return DriverInterventionResultSchema.parse({ status: "applied" });
  }
}

/**
 * Degrades an intervention type no arm routes. The `never` parameter makes a new arm in
 * `ApplyInterventionParams` fail to typecheck here; an untyped caller still gets `degraded`.
 */
function degradeUnroutedInterventionType(params: never): DriverInterventionResult {
  void params;
  return DriverInterventionResultSchema.parse({ status: "degraded" });
}
