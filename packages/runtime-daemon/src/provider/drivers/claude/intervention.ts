// ClaudeInterventionDispatcher — the Claude driver's generic intervention band
// (Plan-005 Phase 3, T3.7).
//
// SPEC COVERAGE
//   * `Spec-005 §Required Behavior` — one generic `applyIntervention(params)` dispatcher plus
//     the degraded-fallback answer, rather than a per-intervention method set.
//   * ADR-011 (generic intervention dispatch) — a provider without a native
//     mechanism for an intervention type answers `degraded` and names the
//     daemon's fallback; `queue_and_interrupt` is the documented fallback for a
//     no-native-steer provider.
//
// I-005-4 (the load-bearing invariant of this file): an intervention type this
// driver cannot dispatch natively returns a `degraded` RESULT — never a thrown
// error, and never a silent no-op. Those are three separate conjuncts, and the
// third is the one a return-value assertion alone does not cover, so the degraded
// steer arm below writes NOTHING to the provider: no user-text frame, no control
// request. A driver that sent the steer text and then reported `degraded` would
// double-apply the intervention the daemon is about to queue.
//
// WHY CLAUDE STEERS DEGRADED. The V1 capability matrix declares `steer: false`
// for Claude, and the pinned wire surface agrees: the control-request registry at
// `2.1.245` carries no steer subtype
// (`docs/reference/provider-wire/claude.md` §Control-request registry). The only
// other route would be writing the steer text as an ordinary user frame, which is
// not a steer at all — it is an out-of-band turn the daemon never admitted. So
// the degrade is a fact about the provider, not a policy knob, and it is stated
// once here. T3.8's `capabilities.ts` MUST declare `steer: false` in agreement;
// the two surfaces are checked against each other by the Phase-3 integration
// test, not by a runtime flag this band reads.
//
// FAILURE POLARITY, stated once and applied to every arm:
//   * a TYPED `control_response` error (the wire reference's "registry
//     membership is not availability" refusal) => `degraded`. The provider was
//     reached and answered; the intervention did not take effect. No
//     `fallbackAction` is named, because no fallback is documented for a refused
//     interrupt and inventing one here would put a verb into the daemon's mouth.
//   * a TRANSPORT EXCEPTION (broken pipe, dead process, timeout) => PROPAGATES.
//     `degraded` asserts a dispatch that reached the provider; laundering an
//     exception into it would report a delivery that never happened.
//   * no live channel for the target run => PROPAGATES as
//     `ClaudeSessionUnavailableError`, for the same reason. This is a routing
//     fault, not an unsupported capability, and I-005-4 governs the latter.
//
// P0-3 — THE CALLER'S IDEMPOTENCY KEY HAS NO WIRE HOME HERE, AND NONE IS
// INVENTED. `ApplyInterventionParams` carries the requester's
// `clientIdempotencyKey` on every arm, and P0-3's obligation is that a driver
// thread it to the wire UNCHANGED — never re-minting it, since a fresh value per
// retry defeats the `interventions` UNIQUE guard the key exists to feed. The
// pinned `interrupt` control request carries `{ subtype, cancel_queued }` and no
// client-supplied identifier, and the transport's own `request_id` is
// response-correlation state that a retry MUST vary, so it is not that home
// either. So this band sends nothing, for the same reason `interruptRun` drops
// `reason`: an unregistered wire field is a worse answer than an absent one.
// Both dispatched arms are consequently free of the key by construction, and the
// steer arm writes nothing at all.
//
// P3-1 — AN AMBIGUOUS ACK NEVER READS AS SUCCESS. A `control_response` success
// is not self-evidently an applied CANCEL. Under the `interrupt_receipt_v1`
// capability the success payload carries `still_queued`, the uuids of async user
// messages that SURVIVED the interrupt (the wire reference's capability note),
// and a cancel that leaves queued messages behind has not cancelled the run's
// remaining input — reporting `applied` there would tell the daemon a
// participant's cancellation took hold while messages it was meant to stop are
// still waiting to run. That success degrades. An interrupt (`cancelQueued`
// false) is graded differently on the same field, because survival is precisely
// what distinguishes it from a cancel: there, a non-empty list is the contract
// working, not a partial application.

import {
  DriverInterventionResultSchema,
  type ApplyInterventionParams,
  type DriverInterventionResult,
  type RunId,
} from "@ai-sidekicks/contracts";

import { ClaudeSessionUnavailableError, type ClaudeRunChannelLookup } from "./lifecycle.js";

// ADR-011's documented fallback for a no-native-steer provider: the daemon
// queues the steer content and interrupts the running turn so the queued content
// is picked up at the next turn boundary. The daemon reads it as a hint, not a
// command. Its `DRIVER_FALLBACK_ACTION_MAX_LEN` bound is ENFORCED rather than
// asserted: every result this module returns is built through
// `DriverInterventionResultSchema.parse`, so an over-long or misshapen action
// fails here instead of travelling as a malformed envelope.
export const CLAUDE_STEER_FALLBACK_ACTION: string = "queue_and_interrupt";

// The success-payload key carrying the uuids of async user messages that
// outlived an interrupt. Present only on builds advertising the optional
// `interrupt_receipt_v1` capability token, which is why absence is read as "this
// build reported nothing" and never as "nothing survived".
const CLAUDE_INTERRUPT_RECEIPT_SURVIVOR_KEY = "still_queued";

/**
 * Counts the queued messages the provider reports as having survived (P3-1).
 *
 * Total over an arbitrary payload on purpose: this value crosses the provider
 * trust boundary, so a missing key, a null, or a non-array all read as "reported
 * nothing" rather than throwing. Zero is therefore returned for both "the build
 * has no receipt capability" and "the receipt was empty" — the two are
 * deliberately not distinguished here, because degrading a cancel on a build
 * that never promised a receipt would fail closed on an absent guarantee rather
 * than on an observed survivor.
 */
function countSurvivingQueuedMessages(payload: Record<string, unknown> | undefined): number {
  const survivors = payload?.[CLAUDE_INTERRUPT_RECEIPT_SURVIVOR_KEY];
  return Array.isArray(survivors) ? survivors.length : 0;
}

export interface ClaudeInterventionDispatcherDependencies {
  readonly channelLookup: ClaudeRunChannelLookup;
}

export class ClaudeInterventionDispatcher {
  readonly #channelLookup: ClaudeRunChannelLookup;

  constructor(dependencies: ClaudeInterventionDispatcherDependencies) {
    this.#channelLookup = dependencies.channelLookup;
  }

  async applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    switch (params.type) {
      case "steer": {
        // Deliberately answered WITHOUT resolving the run: "this provider has no
        // native steer" is a fact about the driver, not about the run, so it
        // cannot depend on whether a channel is currently live. Nothing is sent.
        return DriverInterventionResultSchema.parse({
          status: "degraded",
          fallbackAction: CLAUDE_STEER_FALLBACK_ACTION,
        });
      }
      case "interrupt": {
        return await this.#dispatchInterrupt(params.targetRunId, false);
      }
      case "cancel": {
        // Claude has no `cancel` control subtype. The nearest native mechanism is
        // the interrupt request carrying `cancelQueued`, so queued async user
        // messages cannot silently resume a run the participant cancelled.
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
      // No `fallbackAction`: the provider refused THIS request, which says
      // nothing about what the daemon should do instead. The key is omitted
      // rather than set to `undefined` — under `exactOptionalPropertyTypes` and a
      // `.strict()` envelope those are different values.
      return DriverInterventionResultSchema.parse({ status: "degraded" });
    }
    if (cancelQueued && countSurvivingQueuedMessages(response.response) > 0) {
      // A cancel the provider acknowledged while reporting survivors (P3-1).
      // Also no `fallbackAction`: the survivors are already queued, so the
      // documented `queue_and_interrupt` fallback would re-queue what is queued,
      // and naming any other verb here would invent daemon behaviour this band
      // has no standing to specify.
      return DriverInterventionResultSchema.parse({ status: "degraded" });
    }
    return DriverInterventionResultSchema.parse({ status: "applied" });
  }
}

// The `never` parameter is the compile-time half: if `ApplyInterventionParams`
// ever grows a fourth arm, this call stops typechecking and the new arm must be
// routed deliberately. The runtime half is I-005-4's "never a throw" clause —
// an untyped caller that reaches this branch still receives a `degraded` result.
// No `fallbackAction` is named: an unrouted type has no known fallback, and
// asserting one would be worse than admitting ignorance.
function degradeUnroutedInterventionType(params: never): DriverInterventionResult {
  void params;
  // Parsing a statically-known-valid literal cannot throw, so routing this arm
  // through the schema costs nothing and keeps I-005-4's "never a throw" clause
  // intact while every other arm is schema-built.
  return DriverInterventionResultSchema.parse({ status: "degraded" });
}
