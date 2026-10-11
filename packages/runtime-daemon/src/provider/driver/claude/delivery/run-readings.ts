// What the Claude delivery stream reads off each session's process while it runs: the open turn's
// run and readings, each run's turn count and initialization, and the runs an interrupt stopped.
// A turn's end settles its run's readings: a paused run keeps them for its next turn on the same
// binding, an interrupted one keeps them as the session's continuable run, which a send or the
// turn Claude Code starts with the steers it kept continues, and any other run's go with it.

import type { ProviderSpentRetriesSignal } from "@ai-sidekicks/contracts/provider/driver/usage-limit";
import type { RunRefusedCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { InboundDelivery } from "../../../../session/run/inbound.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { NormalizedEventReorderBuffer } from "../../reorder-buffer.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import type { ClaudeSentPrompts } from "../run/prompts.js";
import type { ClaudeRunRoutes } from "../run/routes.js";
import { CLAUDE_THREAD_FRAME_ROUTER_CONFIG } from "../session/state.js";
import type { ClaudeOpenToolCall } from "./messages.js";
import { ClaudeStreamedBlocks } from "./streamed-blocks.js";

/** What the stream holds for one session while its process runs. */
export interface ClaudeStreamSession {
  readonly openToolCalls: Map<string, ClaudeOpenToolCall>;
  readonly buffer: NormalizedEventReorderBuffer<InboundDelivery>;
  /** The run whose turn the stream has opened, until that turn's end. */
  turnRunId: RunId | undefined;
  /** How many turns each run took on this process, the epoch its turn end passes the gate under. */
  readonly turnEpochByRun: Map<RunId, number>;
  /** The runs whose `run.provider_initialized` was delivered. */
  readonly initializedRuns: Set<RunId>;
  /** The words Claude Code sent the model for each failed or denied call of the turn. */
  readonly failedCallWords: Map<string, string>;
  /** The refusal no other model took, which ends the turn refused. */
  refusal: RunRefusedCause | undefined;
  spentRetries: ProviderSpentRetriesSignal | undefined;
  /** The permission mode the process last reported it runs in. */
  permissionMode: string | undefined;
  /** The runs whose turn the driver's own interrupt is stopping. */
  readonly interruptedRuns: Set<RunId>;
  /**
   * The newest run whose turn ended interrupted, whose readings are kept for its next turn, and
   * whether it holds the session's turn into the one Claude Code starts with the steers it kept.
   */
  continuableRun: { readonly runId: RunId; readonly isCarried: boolean } | undefined;
  /**
   * The ids of the events each message of the open turn was written as, by its wire uuid, and
   * those of each streamed block's pieces, by the block's key.
   */
  readonly eventIdsByMessageKey: Map<string, Promise<string | undefined>[]>;
  /** The text and thinking the process is streaming. */
  readonly streamedBlocks: ClaudeStreamedBlocks;
}

/** What the readings are built over and forget an ended run in. */
export interface ClaudeRunReadingsDependencies {
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly runRoutes: Pick<ClaudeRunRoutes, "forgetRun">;
  readonly prompts: Pick<ClaudeSentPrompts, "forgetRun">;
}

/** Each live session's readings, and what a turn's end leaves of its run's. */
export class ClaudeRunReadings {
  readonly #dependencies: ClaudeRunReadingsDependencies;
  readonly #sessions: Map<SessionId, ClaudeStreamSession> = new Map();

  constructor(dependencies: ClaudeRunReadingsDependencies) {
    this.#dependencies = dependencies;
  }

  /** The session's readings, or `undefined` before its process delivered anything. */
  find(sessionId: SessionId): ClaudeStreamSession | undefined {
    return this.#sessions.get(sessionId);
  }

  /** The session's readings, empty ones made at its process's first delivery. */
  sessionFor(sessionId: SessionId): ClaudeStreamSession {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const session: ClaudeStreamSession = {
      openToolCalls: new Map(),
      buffer: new NormalizedEventReorderBuffer<InboundDelivery>({
        provider: CLAUDE_DRIVER_NAME,
        diagnostics: this.#dependencies.diagnostics,
        maxBufferedEvents: CLAUDE_THREAD_FRAME_ROUTER_CONFIG.maxPendingHoldFrames,
        pairingTimeoutMs: CLAUDE_THREAD_FRAME_ROUTER_CONFIG.pendingRegistrationTimeoutMs,
      }),
      turnRunId: undefined,
      turnEpochByRun: new Map(),
      initializedRuns: new Set(),
      failedCallWords: new Map(),
      refusal: undefined,
      spentRetries: undefined,
      permissionMode: undefined,
      interruptedRuns: new Set(),
      continuableRun: undefined,
      eventIdsByMessageKey: new Map(),
      streamedBlocks: new ClaudeStreamedBlocks(this.#dependencies.diagnostics),
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  /** Forgets a session whose process is gone. */
  forgetSession(sessionId: SessionId): void {
    this.#sessions.delete(sessionId);
  }

  /**
   * Settles what a turn's end leaves of the run `change` ends: nothing for a paused run, the
   * session's continuable run for an interrupted one, carried into Claude Code's next turn when
   * `isCarried`, and every other run's readings forgotten.
   */
  settleEndedRun(
    session: ClaudeStreamSession,
    change: { readonly runId: RunId; readonly newState: string },
    isCarried: boolean,
  ): void {
    if (change.newState === "paused") {
      return;
    }
    if (change.newState !== "interrupted") {
      this.#forgetEndedRun(session, change.runId);
      return;
    }
    const previous = session.continuableRun;
    if (previous !== undefined && previous.runId !== change.runId) {
      this.#forgetEndedRun(session, previous.runId);
    }
    session.openToolCalls.clear();
    session.continuableRun = { runId: change.runId, isCarried };
  }

  /**
   * Takes the session's continuable run as a turn of `runId` opens, forgetting it when the turn is
   * another run's, and answers whether this turn is the one Claude Code started with the steers
   * the run kept, which continues it.
   */
  takeContinuableRun(session: ClaudeStreamSession, runId: RunId): boolean {
    const continuable = session.continuableRun;
    session.continuableRun = undefined;
    if (continuable !== undefined && continuable.runId !== runId) {
      this.#forgetEndedRun(session, continuable.runId);
    }
    return continuable?.runId === runId && continuable.isCarried;
  }

  // An ended run's readings: its binding, its turn count and its initialization, and the tool
  // calls its turn left open, which can no longer complete.
  #forgetEndedRun(session: ClaudeStreamSession, runId: RunId): void {
    this.#dependencies.runRoutes.forgetRun(runId);
    this.#dependencies.prompts.forgetRun(runId);
    session.turnEpochByRun.delete(runId);
    session.initializedRuns.delete(runId);
    session.openToolCalls.clear();
  }
}
