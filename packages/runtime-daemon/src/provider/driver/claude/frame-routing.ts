// Routing each inbound Claude frame through its session's routing band: the thread router decides
// whether it projects, and the usage accountant meters it. Subagent starts and stops register and
// complete child threads, and the session's own handshake and compaction boundaries are tapped.

import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import type { PendingCompactionRegistry } from "../../compaction-wait.js";
import type { DriverDiagnosticsEmitter } from "../diagnostics.js";
import type { SubagentLifecycleEmission, ThreadFrameRoute } from "../../thread-frame-router.js";
import type { CumulativeAxisReadings, MeteredUsageDelta } from "../../usage-delta-accountant.js";
import {
  CLAUDE_SUBAGENT_START_SIGNAL,
  classifyClaudeFrameFamilyForRouting,
  normalizeClaudeSubagentLifecycle,
} from "./event-normalizer.js";
import type { ClaudeInboundFrameObservation } from "./session/transport.js";
import type {
  ClaudeRoutableFrame,
  ClaudeSessionLifecycleDependencies,
  ClaudeSessionRoutingBand,
  ClaudeUsageEstablishment,
} from "./session/state.js";
import { describeFailure, sanitizeFailureDetail } from "./session/errors.js";
import type { ClaudeHandshakeRegister } from "./handshake-register.js";

/** The consumers routing feeds, and the registers its session-thread taps write into. */
export interface ClaudeFrameRoutingDependencies extends Pick<
  ClaudeSessionLifecycleDependencies,
  | "diagnostics"
  | "readPriorEmittedUsage"
  | "onMeteredUsage"
  | "onSubagentLifecycle"
  | "onReleasedFrameRoute"
> {
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly handshakes: ClaudeHandshakeRegister;
}

/** Routes and meters the frames of every session through the routing band the lifecycle holds. */
export class ClaudeFrameRouting {
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #readPriorEmittedUsage:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  readonly #onMeteredUsage: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  readonly #onSubagentLifecycle:
    | ((sessionId: SessionId, emission: SubagentLifecycleEmission) => void)
    | undefined;
  readonly #onReleasedFrameRoute:
    | ((
        sessionId: SessionId,
        observation: ClaudeInboundFrameObservation,
        route: ThreadFrameRoute,
      ) => void)
    | undefined;
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #handshakes: ClaudeHandshakeRegister;

  constructor(dependencies: ClaudeFrameRoutingDependencies) {
    this.#diagnostics = dependencies.diagnostics;
    this.#readPriorEmittedUsage = dependencies.readPriorEmittedUsage;
    this.#onMeteredUsage = dependencies.onMeteredUsage;
    this.#onSubagentLifecycle = dependencies.onSubagentLifecycle;
    this.#onReleasedFrameRoute = dependencies.onReleasedFrameRoute;
    this.#pendingCompactions = dependencies.pendingCompactions;
    this.#handshakes = dependencies.handshakes;
  }

  /**
   * Binds a session's own thread into the band. Base registers come first, because a released usage
   * frame meters immediately and an unestablished thread refuses it; released frames are re-routed,
   * not shed, since a frame that raced the binding must not be lost.
   */
  bindSessionThread(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    providerSessionId: string,
    establishment: ClaudeUsageEstablishment,
  ): void {
    if (establishment.mode === "fresh") {
      band.accountant.establishThread(providerSessionId, { mode: "fresh" });
    } else {
      band.accountant.establishThread(providerSessionId, {
        mode: "resume",
        priorEmittedCumulative:
          this.#readPriorEmittedSum(sessionId, establishment.priorEmittedThreadId) ?? {},
      });
    }
    this.#releaseHeldFrames(band, sessionId, band.router.registerSessionThread(providerSessionId));
  }

  /**
   * Reads the daemon's own prior-emitted cumulative sum for one thread. Only the faulty arms (no
   * reader bound, or a reader that threw) are recorded; an `undefined` answer means nothing
   * emitted.
   */
  #readPriorEmittedSum(
    sessionId: SessionId,
    priorEmittedThreadId: string,
  ): CumulativeAxisReadings | undefined {
    const reader = this.#readPriorEmittedUsage;
    if (reader === undefined) {
      this.#emitResumeBaseUnavailable(
        sessionId,
        priorEmittedThreadId,
        "no prior-emitted usage reader is bound, so the daemon's own emitted sum could not " +
          "be rebuilt; base registers start at zero, so the first post-resume reading meters " +
          "pre-resume spend again",
      );
      return undefined;
    }
    try {
      return reader(sessionId, priorEmittedThreadId);
    } catch (error) {
      // Recorded, not rethrown: this runs inside the adoption window, where a throw would orphan a
      // live provider process; over-metering is recoverable, an orphan is not.
      this.#emitResumeBaseUnavailable(
        sessionId,
        priorEmittedThreadId,
        `the prior-emitted usage reader failed, so the daemon's own emitted sum could not be ` +
          `rebuilt (${sanitizeFailureDetail(describeFailure(error))}); base registers start at ` +
          `zero, so the first post-resume reading meters pre-resume spend again`,
      );
      return undefined;
    }
  }

  #emitResumeBaseUnavailable(
    sessionId: SessionId,
    priorEmittedThreadId: string,
    dispositionReason: string,
  ): void {
    this.#diagnostics.emit({
      provider: "claude",
      kind: "usage_resume_base_unavailable",
      rawWireType: null,
      dispositionReason,
      details: { sessionId, threadId: priorEmittedThreadId },
    });
  }

  /**
   * Re-routes frames released from the router's pending-registration hold and hands each decision
   * to the released-frame consumer: no observer call is in flight to carry it back as a return
   * value. Applying the decision alone would drop the interactive request the carve-out keeps
   * reachable.
   */
  #releaseHeldFrames(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    releasedFrames: readonly ClaudeRoutableFrame[],
  ): void {
    const nowMs = Date.now();
    for (const releasedFrame of releasedFrames) {
      const route = band.router.routeFrame(releasedFrame, nowMs);
      this.#applyRouteDecision(band, sessionId, releasedFrame, route);
      this.#onReleasedFrameRoute?.(sessionId, releasedFrame.observation, route);
    }
  }

  /**
   * Routes one observed inbound frame and answers with the transport's decision. A `SubagentStart`
   * registers its child before the frame routes, or the frame would be held for its own
   * registration; a `SubagentStop` completes the child after, so the stop frame is still
   * suppressed.
   */
  observeInboundFrame(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    providerSessionId: string,
    observation: ClaudeInboundFrameObservation,
  ): ThreadFrameRoute {
    const router = band.router;

    // Taps run beside the ordinary route: every frame still normalizes, so a compaction boundary
    // yields its `usage.context_compacted` row whether or not anyone waits. Only the session's own
    // thread counts; a child's handshake or compaction says nothing about the parent binding.
    if (observation.subagentId === null) {
      if (observation.handshake !== null) {
        this.#handshakes.observeHandshakeDeclaration(
          sessionId,
          providerSessionId,
          observation.handshake,
        );
      }
      if (observation.compactionBoundary !== null) {
        this.#pendingCompactions.observeBoundary(
          sessionId,
          observation.compactionBoundary.boundaryPosition,
        );
      }
    }

    const lifecycleSignal = observation.subagentLifecycle;
    if (lifecycleSignal !== null && lifecycleSignal.signal === CLAUDE_SUBAGENT_START_SIGNAL) {
      const normalized = normalizeClaudeSubagentLifecycle(lifecycleSignal, providerSessionId);
      if (normalized.announcement !== null) {
        const registration = router.registerChildThread(normalized.announcement);
        if (registration.registered) {
          if (band.accountant.hasThread(registration.childThreadId)) {
            // A repeat announcement for a known child: re-establishing would zero its register and
            // double-count its spend, and a second `subagent.started` would duplicate its
            // transcript entry. Recorded, not returned on.
            this.#diagnostics.emit({
              provider: "claude",
              kind: "thread_duplicate_child_announcement",
              rawWireType: observation.frameKind,
              dispositionReason:
                "duplicate subagent announcement for an already-registered child; usage base " +
                "retained and no second started emission",
              details: { sessionId, childThreadId: registration.childThreadId },
            });
          } else {
            // A new provider thread starts at zero. Establishing now, not lazily, keeps the usage
            // carve-out reachable: the accountant refuses an unestablished thread.
            band.accountant.establishThread(registration.childThreadId, { mode: "fresh" });
            this.#onSubagentLifecycle?.(sessionId, {
              eventType: "subagent.started",
              subagentId: normalized.subagentId,
              parentReference: normalized.parentToolUseId,
            });
          }
          // Released on both arms: a hold exists only for an unseen identity, and a conditional
          // release would tie the hold to a metering decision.
          this.#releaseHeldFrames(band, sessionId, registration.releasedFrames);
        }
      }
    }

    const frame: ClaudeRoutableFrame = {
      rawWireType: observation.frameKind,
      familyClass: classifyClaudeFrameFamilyForRouting(observation.frameKind, observation),
      // No thread id on this wire: the subagent identity is the child's, and its absence marks the
      // session's own thread.
      threadId: observation.subagentId ?? providerSessionId,
      observation,
    };
    const route = router.routeFrame(frame, Date.now());
    this.#applyRouteDecision(band, sessionId, frame, route);
    return route;
  }

  #applyRouteDecision(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    frame: ClaudeRoutableFrame,
    route: ThreadFrameRoute,
  ): void {
    switch (route.decision) {
      case "project":
      case "route-connection-scoped":
      case "carve-out-usage":
        // Usage is metered ahead of suppression: a child's spend counts even though its content
        // does not.
        this.#meterObservedUsage(band, sessionId, frame);
        this.#completeChildOnStopSignal(band, sessionId, frame);
        return;
      case "suppress-child-transcript":
        this.#completeChildOnStopSignal(band, sessionId, frame);
        return;
      case "carve-out-interactive-request":
      case "held-pending-registration":
      case "quarantined":
        // The interactive ask travels on the decision, which every caller delivers, so a child's
        // ask reaches the parent's approval pipeline. The router already records held and
        // quarantined frames, so neither is a silent drop.
        return;
    }
  }

  #meterObservedUsage(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    frame: ClaudeRoutableFrame,
  ): void {
    const cumulativeUsage = frame.observation.cumulativeUsage;
    if (cumulativeUsage === null) {
      return;
    }
    const metered = band.accountant.meterReading({
      threadId: frame.threadId,
      namedTurnId: cumulativeUsage.namedTurnId,
      cumulative: cumulativeUsage.cumulative,
      declaredPerTurn: cumulativeUsage.declaredPerTurn ?? null,
    });
    if (metered !== null) {
      this.#onMeteredUsage?.(sessionId, metered);
    }
  }

  /** Closes a child's `subagent.*` pair on its `SubagentStop`, its only close signal. */
  #completeChildOnStopSignal(
    band: ClaudeSessionRoutingBand,
    sessionId: SessionId,
    frame: ClaudeRoutableFrame,
  ): void {
    const lifecycleSignal = frame.observation.subagentLifecycle;
    if (lifecycleSignal === null || lifecycleSignal.signal === CLAUDE_SUBAGENT_START_SIGNAL) {
      return;
    }
    const attribution = band.router.childAttributionFor(lifecycleSignal.subagentId);
    const completion = band.router.completeChildThread(lifecycleSignal.subagentId);
    if (!completion.wasRegistered) {
      return;
    }
    band.accountant.releaseThread(lifecycleSignal.subagentId);
    if (attribution?.kind === "subagent") {
      this.#onSubagentLifecycle?.(sessionId, {
        eventType: "subagent.completed",
        subagentId: attribution.subagentId,
        parentReference: lifecycleSignal.parentToolUseId,
      });
    }
  }
}
