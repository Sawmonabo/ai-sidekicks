// A turn Claude Code starts by itself, with a message a turn ended without taking or when a
// background command it ran ends: no run or command holds the session's turn when its
// `system/init` arrives, so the session's own run opens for it. The session's frames, turn ends
// and requests wait in order while the run opens, then go on as if just received, so none of the
// turn's frames reaches the run engine before its run exists. The wait is bounded in items; past
// it they go on, and the run, once open, takes the rest. A paused lead run takes the turn itself,
// since its pause stops that turn again. A turn whose run cannot open is interrupted, so no turn
// runs with no run.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ThreadFrameRoute } from "../../../thread-frame-router.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import type { ClaudeRunPauses } from "../hooks/pause.js";
import { sendClaudeInterrupt } from "../intervention.js";
import { describeFailure } from "../session/errors.js";
import { CLAUDE_THREAD_FRAME_ROUTER_CONFIG, type LiveClaudeSession } from "../session/state.js";
import type { ClaudeInboundRequestEvent } from "../session/transport.js";
import type { ClaudeRunRoutes } from "./routes.js";

/** One thing the session's process delivered, in the order it arrived. */
export type ClaudeSessionArrival =
  | {
      readonly kind: "frame";
      readonly frame: Readonly<Record<string, unknown>>;
      readonly route: ThreadFrameRoute;
    }
  | { readonly kind: "terminal" }
  | { readonly kind: "request"; readonly event: ClaudeInboundRequestEvent };

/** What opening a run for a turn Claude Code started needs from the lifecycle. */
export interface ClaudeSelfStartedTurnsDependencies {
  readonly runRoutes: Pick<ClaudeRunRoutes, "isTurnHeld" | "holdTurnAgain">;
  readonly pauses: Pick<ClaudeRunPauses, "reportedLeadPause">;
  /** Opens the session's own run for a turn Claude Code started, binding it to the turn. */
  readonly openProviderTurn: (live: LiveClaudeSession) => Promise<RunId>;
  /** Takes one arrival of the session as if it had just arrived. */
  readonly deliver: (live: LiveClaudeSession, arrival: ClaudeSessionArrival) => void;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

// The arrivals of a session whose run is opening, and the process they came from.
interface ClaudeHeldArrivals {
  readonly live: LiveClaudeSession;
  readonly arrivals: ClaudeSessionArrival[];
}

/** Opens the session's own run for each turn Claude Code starts by itself, holding arrivals. */
export class ClaudeSelfStartedTurns {
  readonly #dependencies: ClaudeSelfStartedTurnsDependencies;
  readonly #heldBySession = new Map<SessionId, ClaudeHeldArrivals>();

  constructor(dependencies: ClaudeSelfStartedTurnsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Whether the arrival waits: the session's run for a turn Claude Code started is opening, or
   * this arrival is such a turn's start, whose run it opens.
   */
  holds(live: LiveClaudeSession, arrival: ClaudeSessionArrival): boolean {
    const held = this.#heldBySession.get(live.sessionId);
    if (held !== undefined) {
      held.arrivals.push(arrival);
      if (held.arrivals.length >= CLAUDE_THREAD_FRAME_ROUTER_CONFIG.maxPendingHoldFrames) {
        this.#release(held, true);
      }
      return true;
    }
    if (!this.#isUnheldTurnStart(live.sessionId, arrival)) {
      return false;
    }
    const { pauses, runRoutes } = this.#dependencies;
    const pausedRunId = pauses.reportedLeadPause(live.sessionId);
    if (pausedRunId !== undefined && runRoutes.holdTurnAgain(pausedRunId, live.sessionId)) {
      return false;
    }
    const opening: ClaudeHeldArrivals = { live, arrivals: [arrival] };
    this.#heldBySession.set(live.sessionId, opening);
    void this.#openRun(opening);
    return true;
  }

  // A turn's `system/init` while nothing holds the session's turn, a helper's aside.
  #isUnheldTurnStart(sessionId: SessionId, arrival: ClaudeSessionArrival): boolean {
    return (
      arrival.kind === "frame" &&
      arrival.frame["type"] === "system" &&
      arrival.frame["subtype"] === "init" &&
      arrival.frame["parent_tool_use_id"] == null &&
      !this.#dependencies.runRoutes.isTurnHeld(sessionId)
    );
  }

  async #openRun(opening: ClaudeHeldArrivals): Promise<void> {
    const { live } = opening;
    let openFailure: unknown;
    try {
      await this.#dependencies.openProviderTurn(live);
    } catch (cause) {
      openFailure = cause;
    }
    this.#release(opening, false);
    if (openFailure === undefined) {
      return;
    }
    this.#report(live.sessionId, "no run could open for it", openFailure);
    // A run that started meanwhile holds the turn and takes its frames.
    if (this.#dependencies.runRoutes.isTurnHeld(live.sessionId) || live.channel.isClosed) {
      return;
    }
    try {
      await sendClaudeInterrupt(live.channel, { subtype: "interrupt" });
    } catch (cause) {
      this.#report(live.sessionId, "its interrupt failed", cause);
    }
  }

  // Lets a held turn's arrivals go on in order, once; a release before its run opened is reported.
  #release(held: ClaudeHeldArrivals, isEarly: boolean): void {
    const sessionId = held.live.sessionId;
    if (this.#heldBySession.get(sessionId) !== held) {
      return;
    }
    this.#heldBySession.delete(sessionId);
    if (isEarly) {
      this.#report(sessionId, "its frames filled the wait before its run opened", undefined);
    }
    for (const arrival of held.arrivals) {
      this.#dependencies.deliver(held.live, arrival);
    }
  }

  #report(sessionId: SessionId, what: string, cause: unknown): void {
    this.#dependencies.diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "unmapped_wire_kind",
      rawWireType: "system/init",
      dispositionReason: `a turn Claude Code started by itself: ${what}`,
      details: {
        sessionId,
        ...(cause === undefined ? {} : { cause: describeFailure(cause) }),
      },
    });
  }
}
