// Which Claude session each dispatched run is bound to. The lifecycle binds a route before the
// opening frame's write and retires a session's routes when its turn settles or it closes; the
// tripwire rulings read the routes to find the run a frame belongs to.

import type { RunId, SessionId } from "@ai-sidekicks/contracts";

/** The run-to-session routes of one `ClaudeSessionLifecycle`, in the order the runs were bound. */
export class ClaudeRunRoutes {
  readonly #sessionIdByRunId: Map<RunId, SessionId> = new Map();

  /** Binds a run to the session its opening frame goes to; a rebind replaces the session. */
  bindRun(runId: RunId, sessionId: SessionId): void {
    this.#sessionIdByRunId.set(runId, sessionId);
  }

  /** Drops one run's route. */
  unbindRun(runId: RunId): void {
    this.#sessionIdByRunId.delete(runId);
  }

  /** The session a run is bound to, or `undefined` when it has no route. */
  sessionIdFor(runId: RunId): SessionId | undefined {
    return this.#sessionIdByRunId.get(runId);
  }

  /** Every run bound to this session, oldest binding first. */
  runIdsBoundTo(sessionId: SessionId): RunId[] {
    return [...this.#sessionIdByRunId]
      .filter(([, boundSessionId]) => boundSessionId === sessionId)
      .map(([runId]) => runId);
  }

  /**
   * The one run holding a live turn on this session, or `null` for none or several. No last-bound
   * fallback: it would name a retired run. The several-runs arm is unreachable while `startRun`
   * refuses a second dispatch; it stays fail-closed.
   */
  soleLiveRunOn(sessionId: SessionId): RunId | null {
    let soleRunId: RunId | null = null;
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId !== sessionId) {
        continue;
      }
      if (soleRunId !== null) {
        return null;
      }
      soleRunId = runId;
    }
    return soleRunId;
  }

  /** The run a join key names, checked against the session it is bound to. */
  runIdBoundToSession(joinKey: string, sessionId: SessionId): RunId | undefined {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (runId === joinKey && boundSessionId === sessionId) {
        return runId;
      }
    }
    return undefined;
  }

  /** Drops every run route pointing at this session; the slot is untouched. */
  retireRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
  }
}
