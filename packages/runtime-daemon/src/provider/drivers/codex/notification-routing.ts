// The Codex leg's routing and metering band: binding a session's thread at each establishment,
// routing every inbound notification through the session's thread-frame router, and applying each
// decision (usage metering, compaction boundaries, child completion, the normalize hand-off).

import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import type { PendingCompactionRegistry } from "../../compaction-wait.js";
import type { ThreadFrameRouter, ThreadFrameRoute } from "../../thread-frame-router.js";
import type { CumulativeAxisReadings, UsageDeltaAccountant } from "../../usage-delta-accountant.js";
import {
  CODEX_THREAD_COMPACTED_METHOD,
  CODEX_THREAD_STARTED_METHOD,
  CODEX_THREAD_TOKEN_USAGE_METHOD,
  CODEX_TURN_COMPLETED_METHOD,
  classifyCodexFrameFamilyForRouting,
} from "./event-normalizer.js";
import {
  codexCompactionWaitKey,
  type CodexLifecycleOptions,
  type CodexRoutableFrame,
  type CodexUsageEstablishment,
  readCodexChildThreadAnnouncement,
  readCodexCumulativeUsageReading,
  readCodexFrameThreadId,
  readCodexTerminalTurnStatus,
} from "./session-state.js";
import { normalizeProviderFailureDetail } from "./session-errors.js";
import { readCodexCompactionBoundaryPosition } from "./provider-commands.js";
import { reportDiagnosticFromDetachedFrame } from "./transport-diagnostics.js";

/** The consumers the band feeds, and the per-session router and accountant it reads live. */
export interface CodexNotificationRoutingDependencies {
  readonly options: Pick<
    CodexLifecycleOptions,
    | "diagnostics"
    | "reportDiagnostic"
    | "readPriorEmittedUsage"
    | "onMeteredUsage"
    | "onSubagentLifecycle"
    | "onServerNotification"
  >;
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly frameRouterFor: (sessionId: SessionId) => ThreadFrameRouter<CodexRoutableFrame>;
  readonly usageAccountantFor: (sessionId: SessionId) => UsageDeltaAccountant;
}

/** Routes and meters the notifications of every session through the lifecycle's routing band. */
export class CodexNotificationRouting {
  readonly #options: CodexNotificationRoutingDependencies["options"];
  readonly #pendingCompactions: PendingCompactionRegistry;
  readonly #frameRouterFor: (sessionId: SessionId) => ThreadFrameRouter<CodexRoutableFrame>;
  readonly #usageAccountantFor: (sessionId: SessionId) => UsageDeltaAccountant;

  constructor(dependencies: CodexNotificationRoutingDependencies) {
    this.#options = dependencies.options;
    this.#pendingCompactions = dependencies.pendingCompactions;
    this.#frameRouterFor = dependencies.frameRouterFor;
    this.#usageAccountantFor = dependencies.usageAccountantFor;
  }

  /**
   * Binds the session's thread into the routing and metering band at every establishment. Base
   * registers come first because a released usage frame meters immediately. Registering
   * overwrites the router's session-thread identity, which is how a rewind retires the old thread.
   */
  bindSessionThread(
    sessionId: SessionId,
    threadId: string,
    establishment: CodexUsageEstablishment,
  ): void {
    const accountant = this.#usageAccountantFor(sessionId);
    if (establishment.mode === "fresh") {
      accountant.establishThread(threadId, { mode: "fresh" });
    } else {
      const priorEmittedCumulative = this.#readPriorEmittedSum(
        sessionId,
        threadId,
        establishment.priorEmittedThreadId,
      );
      accountant.establishThread(threadId, {
        mode: "resume",
        priorEmittedCumulative: priorEmittedCumulative ?? {},
      });
    }
    const releasedFrames = this.#frameRouterFor(sessionId).registerSessionThread(threadId);
    this.#deliverRoutedFrames(sessionId, releasedFrames);
  }

  /**
   * Reads the daemon's prior-emitted cumulative sum, reporting only a missing or throwing reader
   * (`undefined` is correct for a session that emitted nothing). The throw is contained because the
   * base is telemetry and must not fail an already-applied fork or resume.
   */
  #readPriorEmittedSum(
    sessionId: SessionId,
    threadId: string,
    priorEmittedThreadId: string,
  ): CumulativeAxisReadings | undefined {
    const reader = this.#options.readPriorEmittedUsage;
    if (reader === undefined) {
      this.#emitResumeBaseUnavailable(
        sessionId,
        threadId,
        priorEmittedThreadId,
        "no prior-emitted usage reader is bound, so the daemon's own emitted sum could not " +
          "be rebuilt; base registers start at zero, so the first reading meters " +
          "already-emitted spend again",
      );
      return undefined;
    }
    try {
      return reader(sessionId, priorEmittedThreadId);
    } catch (cause) {
      this.#emitResumeBaseUnavailable(
        sessionId,
        threadId,
        priorEmittedThreadId,
        `the prior-emitted usage reader failed, so the daemon's own emitted sum could not be ` +
          `rebuilt (${normalizeProviderFailureDetail(cause)}); base registers start at zero, ` +
          `so the first reading meters already-emitted spend again`,
      );
      return undefined;
    }
  }

  // On a rewind the two thread ids differ: the sum is under the pre-fork thread, the registers
  // belong to the forked one.
  #emitResumeBaseUnavailable(
    sessionId: SessionId,
    threadId: string,
    priorEmittedThreadId: string,
    dispositionReason: string,
  ): void {
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "usage_resume_base_unavailable",
      rawWireType: null,
      dispositionReason,
      details: { sessionId, threadId, priorEmittedThreadId },
    });
  }

  /**
   * Routes one inbound notification and delivers what it releases. Must not throw: it runs inside
   * the transport's `#ingest` drain. A child is registered before its announcement is routed.
   */
  routeInboundNotification(sessionId: SessionId, method: string, params: unknown): void {
    const router = this.#frameRouterFor(sessionId);
    if (method === CODEX_THREAD_STARTED_METHOD) {
      const announcement = readCodexChildThreadAnnouncement(params);
      if (announcement !== null) {
        const registration = router.registerChildThread(announcement);
        if (registration.registered) {
          const accountant = this.#usageAccountantFor(sessionId);
          if (accountant.hasThread(registration.childThreadId)) {
            // Re-establishing would zero the register and re-meter reported spend, and a second
            // `subagent.started` would duplicate a transcript entry.
            this.#options.diagnostics.emit({
              provider: CODEX_DRIVER_NAME,
              kind: "thread_duplicate_child_announcement",
              rawWireType: method,
              dispositionReason:
                "duplicate child-thread announcement for an already-registered child; usage " +
                "base retained and no second started emission",
              details: { sessionId, childThreadId: registration.childThreadId },
            });
          } else {
            accountant.establishThread(registration.childThreadId, { mode: "fresh" });
            // A provider-internal child (a compaction thread) has no subagent identity.
            if (registration.attribution.kind === "subagent") {
              this.#options.onSubagentLifecycle?.(sessionId, {
                eventType: "subagent.started",
                subagentId: registration.attribution.subagentId,
                parentReference: announcement.declaredParentThreadId,
              });
            }
          }
          this.#deliverRoutedFrames(sessionId, registration.releasedFrames);
        }
      }
    }

    const frame: CodexRoutableFrame = {
      rawWireType: method,
      familyClass: classifyCodexFrameFamilyForRouting(method),
      threadId: readCodexFrameThreadId(method, params),
      params,
    };
    this.#deliverRoutedFrames(sessionId, [frame]);
  }

  /**
   * Applies the router's decision to each frame. A child's usage still meters and its interactive
   * request still routes, though its transcript never projects.
   */
  #deliverRoutedFrames(sessionId: SessionId, frames: readonly CodexRoutableFrame[]): void {
    const router = this.#frameRouterFor(sessionId);
    const nowMs = Date.now();
    for (const frame of frames) {
      const route = router.routeFrame(frame, nowMs);
      this.#applyRouteDecision(sessionId, frame, route);
    }
  }

  #applyRouteDecision(
    sessionId: SessionId,
    frame: CodexRoutableFrame,
    route: ThreadFrameRoute,
  ): void {
    switch (route.decision) {
      case "project":
      case "route-connection-scoped":
        // Metering first, so the normalize band never forwards a cumulative counter as per-turn.
        this.#meterUsageFrame(sessionId, frame);
        this.#observeCompactionBoundary(sessionId, frame);
        this.#completeChildOnTerminal(sessionId, frame);
        this.#handOffToNormalizeBand(frame);
        return;
      case "carve-out-usage":
        this.#meterUsageFrame(sessionId, frame);
        return;
      case "carve-out-interactive-request":
        // Same pipeline as the parent's, on the child's own correlation identity; suppressing it
        // would hang the child.
        this.#handOffToNormalizeBand(frame);
        return;
      case "suppress-child-transcript":
        this.#completeChildOnTerminal(sessionId, frame);
        return;
      case "held-pending-registration":
      case "quarantined":
        // The router already recorded both as diagnostics.
        return;
    }
  }

  /**
   * Settles a pending compaction wait on `thread/compacted`, beside the normalize hand-off so the
   * boundary row is still produced. Keyed on the frame's own thread id, not the record's, which
   * has moved to the successor at a rewind; an unarmed key is a no-op.
   */
  #observeCompactionBoundary(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_THREAD_COMPACTED_METHOD || frame.threadId === null) {
      return;
    }
    this.#pendingCompactions.observeBoundary(
      codexCompactionWaitKey(sessionId, frame.threadId),
      readCodexCompactionBoundaryPosition(frame.params),
    );
  }

  #meterUsageFrame(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_THREAD_TOKEN_USAGE_METHOD) {
      return;
    }
    const reading = readCodexCumulativeUsageReading(frame.params);
    if (reading === null) {
      // A silent drop is spend that never reaches a receipt.
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "usage_axis_reading_rejected",
        rawWireType: frame.rawWireType,
        dispositionReason:
          "the provider's token-usage notification carried no readable cumulative breakdown " +
          "at the pinned payload shape; nothing was metered for this reading",
        details: { sessionId, threadId: frame.threadId },
      });
      return;
    }
    const metered = this.#usageAccountantFor(sessionId).meterReading(reading);
    if (metered !== null) {
      this.#options.onMeteredUsage?.(sessionId, metered);
    }
  }

  /**
   * Releases a child's router state on its `turn/completed` with a terminal `turn.status`.
   * `thread/status/changed` has no terminal arm, and `thread/closed` is left unclassified because
   * nothing shows the app-server emits it for subagent threads.
   */
  #completeChildOnTerminal(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_TURN_COMPLETED_METHOD || frame.threadId === null) {
      return;
    }
    if (!readCodexTerminalTurnStatus(frame.params)) {
      return;
    }
    const attribution = this.#frameRouterFor(sessionId).childAttributionFor(frame.threadId);
    const completion = this.#frameRouterFor(sessionId).completeChildThread(frame.threadId);
    if (!completion.wasRegistered) {
      return;
    }
    this.#usageAccountantFor(sessionId).releaseThread(frame.threadId);
    if (attribution?.kind === "subagent") {
      this.#options.onSubagentLifecycle?.(sessionId, {
        eventType: "subagent.completed",
        subagentId: attribution.subagentId,
        parentReference: null,
      });
    }
  }

  #handOffToNormalizeBand(frame: CodexRoutableFrame): void {
    const delegate = this.#options.onServerNotification;
    if (delegate === undefined) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "unconsumed-server-notification",
        method: frame.rawWireType,
      });
      return;
    }
    try {
      delegate(frame.rawWireType, frame.params);
    } catch (cause) {
      // Guarded here so this class does not depend on the transport's own containment.
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "notification-consumer-failed",
        method: frame.rawWireType,
        detail: normalizeProviderFailureDetail(cause),
      });
    }
  }
}
