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

import type {
  ApplyInterventionParams,
  DriverInterventionResult,
  RunId,
} from "@ai-sidekicks/contracts";

import { ClaudeSessionUnavailableError, type ClaudeRunChannelLookup } from "./lifecycle.js";

// ADR-011's documented fallback for a no-native-steer provider: the daemon
// queues the steer content and interrupts the running turn so the queued content
// is picked up at the next turn boundary. Bounded by
// `DRIVER_FALLBACK_ACTION_MAX_LEN`; the daemon reads it as a hint, not a command.
export const CLAUDE_STEER_FALLBACK_ACTION: string = "queue_and_interrupt";

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
        return { status: "degraded", fallbackAction: CLAUDE_STEER_FALLBACK_ACTION };
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
      return { status: "degraded" };
    }
    return { status: "applied" };
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
  return { status: "degraded" };
}
