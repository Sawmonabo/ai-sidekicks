// The text-neutralization tripwire on the Claude leg: composing and registering each run-opening
// frame, and ruling every frame when its turn settles, its write fails, its binding is condemned
// or a rewind supersedes it. A trip quarantines the session and the run and reports the run
// failure.

import type { RunId, SessionId, StartRunParams } from "@ai-sidekicks/contracts";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import {
  type OutboundFrameTripwire,
  type OutboundTextFrameWriter,
  type RuntimeBindingQuarantine,
  UNRECOGNIZED_TURN_EVIDENCE,
  composeSupersededDeliveryRunFailure,
  composeTextNeutralizationRunFailure,
  type TextNeutralizationRunFailure,
} from "../outbound-frame.js";
import { classifyClaudeTurnEvidence } from "./turn-evidence.js";
import {
  type ClaudeRunDispatch,
  type ClaudeSessionChannel,
  type ClaudeUserTextDelivery,
  type ClaudeUserTextFrame,
  type ClaudeUserTextWriteAttempt,
  RUN_OPENING_FRAME_ORIGIN,
} from "./session-transport.js";
import type { ClaudeSessionLifecycleDependencies } from "./session-state.js";
import { describeFailure } from "./session-errors.js";
import type { ClaudeRunRoutes } from "./run-routes.js";

/** The lifecycle's frame machinery and the one teardown the tripwire rulings call back into. */
export interface ClaudeTextNeutralizationDependencies extends Pick<
  ClaudeSessionLifecycleDependencies,
  "diagnostics" | "onTextNeutralizationFailure"
> {
  readonly outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly outboundFrameTripwire: OutboundFrameTripwire;
  readonly runtimeBindingQuarantine: RuntimeBindingQuarantine;
  readonly runRoutes: ClaudeRunRoutes;
  /** Rules the condemned session's leftover frames and tears its channel down, detached. */
  readonly disposeQuarantinedSession: (sessionId: SessionId) => void;
}

/**
 * Writes one composed frame, turning a transport rejection into a failed attempt. A rejection
 * carries no claim about the bytes, so it is `indeterminate`, never `unsent`.
 */
export async function attemptClaudeFrameWrite(
  channel: ClaudeSessionChannel,
  frame: ClaudeUserTextFrame,
): Promise<ClaudeUserTextWriteAttempt> {
  try {
    return await channel.sendUserText(frame);
  } catch (cause) {
    return { settled: "failed", delivery: "indeterminate", cause };
  }
}

/**
 * Composes and registers each run-opening frame and rules the tripwire on it, quarantining and
 * reporting what a trip condemns.
 */
export class ClaudeTextNeutralization {
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #runtimeBindingQuarantine: RuntimeBindingQuarantine;
  readonly #runRoutes: ClaudeRunRoutes;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  readonly #disposeQuarantinedSession: (sessionId: SessionId) => void;

  constructor(dependencies: ClaudeTextNeutralizationDependencies) {
    this.#outboundTextFrameWriter = dependencies.outboundTextFrameWriter;
    this.#outboundFrameTripwire = dependencies.outboundFrameTripwire;
    this.#runtimeBindingQuarantine = dependencies.runtimeBindingQuarantine;
    this.#runRoutes = dependencies.runRoutes;
    this.#diagnostics = dependencies.diagnostics;
    this.#onTextNeutralizationFailure = dependencies.onTextNeutralizationFailure;
    this.#disposeQuarantinedSession = dependencies.disposeQuarantinedSession;
  }

  /**
   * Composes one run-opening frame, admits it to the tripwire and binds the run route. Every
   * attempt repeats all three, since an unregistered frame is unwatched.
   */
  registerOpeningDispatch(
    dispatch: ClaudeRunDispatch,
    params: StartRunParams,
  ): ClaudeUserTextFrame {
    // Composed only here, so neutralization sits on the only path to the wire. The origin is a
    // literal, not a `ClaudeRunDispatch` member: `driver_command` would deliver bytes verbatim and
    // exempt the turn from the tripwire.
    const frame = this.#outboundTextFrameWriter.compose({
      text: dispatch.openingText,
      origin: RUN_OPENING_FRAME_ORIGIN,
    });
    // Registered before the route is bound so a refusal mutates nothing: a leftover route would
    // let an interrupt stop an older turn. A refusal aborts before the write; a capacity refusal
    // is unreachable behind `startRun`'s session guard and kept fail-closed.
    this.#outboundFrameTripwire.register({
      scopeKey: dispatch.sessionId,
      joinKey: params.runId,
      frameRole: "turn-opening",
      frame,
    });
    // Bound before the write: an interrupt may race the text on the wire and must find a route.
    this.#runRoutes.bindRun(params.runId, dispatch.sessionId);
    return frame;
  }

  /**
   * Decides what a failed opening frame is owed by how far its bytes got. A channel that dies later
   * without settling is not ruled here, which would trip every clean shutdown mid-turn.
   */
  ruleFailedOpeningFrame(ruling: {
    readonly sessionId: SessionId;
    readonly runId: RunId;
    readonly channel: ClaudeSessionChannel;
    readonly frame: ClaudeUserTextFrame;
    readonly delivery: ClaudeUserTextDelivery;
  }): void {
    if (ruling.delivery === "unsent") {
      // The route goes unless a sibling frame on this run is pending: a stale route lets Claude's
      // channel-scoped interrupt stop an older turn, but deleting it under a pending frame would
      // hide that frame from `ruleTextNeutralizationTripwire`.
      this.#outboundFrameTripwire.forgetFrame(ruling.frame);
      if (!this.#outboundFrameTripwire.hasPendingFrame(ruling.runId)) {
        this.#runRoutes.unbindRun(ruling.runId);
      }
      return;
    }
    // Kept for the turn's own terminal, since the provider may have intercepted the text as a
    // client-side command. It claims the session's next terminal first, so a trip may name the
    // wrong run; the session is quarantined either way.
    if (!ruling.channel.isClosed) {
      return;
    }
    // Dead channel: no terminal will arrive, so rule the frame here, frame-scoped. The route stays
    // so `findChannelForRun` refuses instead of answering `undefined`, which invites a retry.
    const decision = this.#outboundFrameTripwire.settleFrame(
      ruling.frame,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (!decision.tripped) {
      return;
    }
    // Same order as the settlement path: the session first, so a caller reacting synchronously to
    // the run failure cannot reach the condemned process.
    this.#runtimeBindingQuarantine.disposeSession(ruling.sessionId);
    this.#runtimeBindingQuarantine.disposeRun(ruling.runId, ruling.sessionId);
    this.#reportTextNeutralizationFailure(
      ruling.sessionId,
      ruling.runId,
      composeTextNeutralizationRunFailure(decision),
    );
    this.#disposeQuarantinedSession(ruling.sessionId);
  }

  /**
   * Rules the text-neutralization tripwire on a settling turn. Claude's terminal frame names no
   * run, so only the oldest run with a pending frame consumes its evidence; any further correlated
   * run is ruled against none and trips, since retiring the routes means it can never be confirmed.
   */
  ruleTextNeutralizationTripwire(sessionId: SessionId, terminalFrame: unknown): void {
    // Ordered by pending frames, not routes: a run ruled by `ruleFailedOpeningFrame` on the
    // dead-channel arm keeps its route but has no registration, and must not consume live evidence.
    const correlatedRunIds = this.#runRoutes
      .runIdsBoundTo(sessionId)
      .filter((runId) => this.#outboundFrameTripwire.hasPendingFrame(runId));
    if (correlatedRunIds.length === 0) {
      return;
    }
    const settlingClassification = classifyClaudeTurnEvidence(terminalFrame);
    let tripped = false;
    for (const [framePosition, runId] of correlatedRunIds.entries()) {
      // `startRun` allows one pending frame per session, so positions past 0 are unreachable; kept
      // fail-closed, since crediting the real verdict to two runs would let a swallow ride a
      // sibling.
      const classification =
        framePosition === 0 ? settlingClassification : UNRECOGNIZED_TURN_EVIDENCE;
      const decision = this.#outboundFrameTripwire.settle(runId, classification);
      if (!decision.tripped) {
        continue;
      }
      if (!tripped) {
        tripped = true;
        // Quarantined first and on both axes, so a caller reacting synchronously cannot reach the
        // process that swallowed the text by either door.
        this.#runtimeBindingQuarantine.disposeSession(sessionId);
      }
      this.#runtimeBindingQuarantine.disposeRun(runId, sessionId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeTextNeutralizationRunFailure(decision),
      );
    }
    if (tripped) {
      this.#disposeQuarantinedSession(sessionId);
    }
  }

  /**
   * Rules every frame a condemned binding leaves unsettled, fail closed, with
   * `UNRECOGNIZED_TURN_EVIDENCE`: `ruleFailedOpeningFrame` is frame-scoped, so a sibling run's
   * frame would otherwise sit pending forever. Reported once per run, with the trip's cause.
   */
  ruleAbandonedFramesFailClosed(sessionId: SessionId): void {
    const rulings = this.#outboundFrameTripwire.settleScope(sessionId, UNRECOGNIZED_TURN_EVIDENCE);
    for (const ruling of rulings) {
      if (!ruling.decision.tripped) {
        continue;
      }
      const runId = this.#runRoutes.runIdBoundToSession(ruling.joinKey, sessionId);
      if (runId === undefined || this.#runtimeBindingQuarantine.isRunDisposed(runId)) {
        continue;
      }
      this.#runtimeBindingQuarantine.disposeRun(runId, sessionId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeTextNeutralizationRunFailure(ruling.decision),
      );
    }
  }

  // A throwing consumer must not become a second failure: the run terminal is the guarantee, and
  // losing it would leave the swallowed turn with no record.
  #reportTextNeutralizationFailure(
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ): void {
    try {
      this.#onTextNeutralizationFailure(sessionId, runId, failure);
    } catch (error) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "text_neutralization_trip_report_failed",
        rawWireType: null,
        dispositionReason: describeFailure(error),
        details: { sessionId, runId, providerFailureDetail: failure.providerFailureDetail },
      });
    }
  }

  /**
   * Fails the runs whose frames a rewind superseded before the provider settled them, so user text
   * that may not have reached the model never vanishes. No terminal can settle them (the
   * successor's hook is identity-gated). Not a trip and not quarantined: the runs keep their
   * interrupt controls.
   */
  failSupersededDeliveries(sessionId: SessionId): void {
    const abandoned = this.#outboundFrameTripwire.abandonScope(sessionId);
    const reportedRunIds = new Set<RunId>();
    for (const frame of abandoned) {
      const runId = this.#runRoutes.runIdBoundToSession(frame.joinKey, sessionId);
      // The lookup only brands the join key as a run id; an unresolved key cannot occur.
      if (runId === undefined || reportedRunIds.has(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeSupersededDeliveryRunFailure(frame.detailOrigin),
      );
    }
  }
}
