// A turn Codex starts on a session by itself, such as its work on an active goal: the session's
// own run opens on the turn's `turn/started`, never before, so a goal Codex leaves alone makes no
// run. The session's frames wait in order while the run opens, then go on as if just received, so
// none of the turn's frames reaches the run engine before its run exists. The wait is bounded in
// frames and in time; past either, the frames go on and the turn's run, once open, takes the rest.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { CODEX_TURN_STARTED_METHOD } from "../event-normalizer.js";
import { normalizeProviderFailureDetail } from "../session/errors.js";
import {
  CODEX_THREAD_FRAME_ROUTER_CONFIG,
  type CodexSessionRecord,
  isTurnInFlight,
} from "../session/state.js";
import {
  type CodexDiagnosticSink,
  type CodexScheduleTimeout,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";
import type { CodexRunStart } from "./start.js";

interface CodexHeldFrame {
  readonly method: string;
  readonly params: unknown;
}

/** What opening a run for a turn Codex started needs from the lifecycle. */
export interface CodexSelfStartedTurnsDependencies {
  readonly recordFor: (sessionId: SessionId) => CodexSessionRecord | undefined;
  readonly runStart: Pick<CodexRunStart, "startDaemonTurn" | "turnStartTimeoutMs">;
  /** Takes one frame of the session as if it had just arrived. */
  readonly ingest: (sessionId: SessionId, method: string, params: unknown) => void;
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly scheduleTimeout: CodexScheduleTimeout;
}

/** Opens the session's own run for each turn Codex starts by itself, holding frames meanwhile. */
export class CodexSelfStartedTurns {
  readonly #dependencies: CodexSelfStartedTurnsDependencies;
  // The frames of each session whose run is opening, in arrival order, and the wait's deadline.
  readonly #heldBySession = new Map<
    SessionId,
    { readonly frames: CodexHeldFrame[]; readonly cancelDeadline: () => void }
  >();

  constructor(dependencies: CodexSelfStartedTurnsDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Whether the frame waits: the session's run for a turn Codex started is opening, or this frame
   * is such a turn's start, whose run it opens.
   */
  holds(sessionId: SessionId, method: string, params: unknown): boolean {
    const held = this.#heldBySession.get(sessionId);
    if (held !== undefined) {
      held.frames.push({ method, params });
      if (held.frames.length >= CODEX_THREAD_FRAME_ROUTER_CONFIG.maxPendingHoldFrames) {
        this.#release(sessionId, "hold-full");
      }
      return true;
    }
    const record = this.#dependencies.recordFor(sessionId);
    if (record === undefined) {
      return false;
    }
    const turnId = readProviderStartedTurnId(record, method, params);
    if (turnId === undefined) {
      return false;
    }
    const cancelDeadline = this.#dependencies.scheduleTimeout(() => {
      this.#release(sessionId, "hold-deadline");
    }, this.#dependencies.runStart.turnStartTimeoutMs);
    this.#heldBySession.set(sessionId, { frames: [{ method, params }], cancelDeadline });
    const opened = Promise.withResolvers<void>();
    record.delivery.selfStartedTurnOpening = { turnId, opened: opened.promise };
    void this.#openRun(record, turnId).finally(opened.resolve);
    return true;
  }

  async #openRun(record: CodexSessionRecord, turnId: string): Promise<void> {
    try {
      await this.#dependencies.runStart.startDaemonTurn(record, async () => turnId, turnId);
    } catch (cause) {
      // No run takes the turn: its frames go on as frames of a turn no run holds.
      record.delivery.unownedTurnIds.add(turnId);
      reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
        kind: "provider-turn-run-failed",
        sessionId: record.sessionId,
        detail: normalizeProviderFailureDetail(cause),
      });
    } finally {
      if (record.delivery.selfStartedTurnOpening?.turnId === turnId) {
        record.delivery.selfStartedTurnOpening = undefined;
      }
      this.#release(record.sessionId, undefined);
    }
  }

  // Lets the session's held frames go on in order; a release before the run opened is reported.
  #release(sessionId: SessionId, early: "hold-full" | "hold-deadline" | undefined): void {
    const held = this.#heldBySession.get(sessionId);
    if (held === undefined) {
      return;
    }
    this.#heldBySession.delete(sessionId);
    held.cancelDeadline();
    if (early !== undefined) {
      reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
        kind: "provider-turn-frames-released",
        sessionId,
        reason: early,
        frameCount: held.frames.length,
      });
    }
    for (const frame of held.frames) {
      this.#dependencies.ingest(sessionId, frame.method, frame.params);
    }
  }
}

// The turn a `turn/started` names on the session's own conversation when no run started it: no
// turn of the session's runs, nothing starting, and not one whose run already failed to open.
function readProviderStartedTurnId(
  record: CodexSessionRecord,
  method: string,
  params: unknown,
): string | undefined {
  const payload = isPlainObject(params) ? params : {};
  if (method !== CODEX_TURN_STARTED_METHOD || payload["threadId"] !== record.threadId) {
    return undefined;
  }
  const turn = isPlainObject(payload["turn"]) ? payload["turn"] : {};
  const turnId = readNonEmptyString(turn, "id");
  if (
    turnId === undefined ||
    isTurnInFlight(record) ||
    record.settledTurnIds.has(turnId) ||
    record.delivery.unownedTurnIds.has(turnId)
  ) {
    return undefined;
  }
  return turnId;
}
