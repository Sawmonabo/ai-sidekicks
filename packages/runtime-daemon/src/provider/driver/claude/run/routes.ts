// Which Claude session each dispatched run is bound to, and the runtime binding its deliveries are
// attributed on. The lifecycle binds a route before the opening text's write and retires a
// session's routes when its turn settles, a rewind supersedes it or it closes; a bound route, or a
// command Claude Code runs as a turn of its own, is the session's one turn in flight. A run's
// binding outlives its turn's hold, since a paused run takes its next turn on the same binding,
// and goes when the run ends. A helper Claude Code started is a child run, routed by the
// provider's own agent id, which its frames and hook callbacks carry. A run apart from the
// session's process, such as a review of the staged changes, holds no turn there and is routed
// only to how it is stopped.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { scheduleUnrefTimer } from "../session/control-requests.js";

/**
 * Where a helper's child run lives: its session, the agent id its frames and hook callbacks
 * carry, the lead run it was started beneath, and the binding the lead's process is attributed on.
 */
export interface ClaudeChildRunRoute {
  readonly sessionId: SessionId;
  readonly agentId: string;
  readonly parentRunId: RunId;
  readonly bindingId: string;
}

/** A run and the runtime binding its deliveries are attributed on. */
export interface ClaudeBoundRun {
  readonly runId: RunId;
  readonly bindingId: string;
}

interface ClaudeRunBinding {
  readonly sessionId: SessionId;
  readonly bindingId: string;
}

/**
 * Stops a run apart from its session's process; `isEndWritten` is `true` when the daemon writes the
 * run's end itself, so the run must not end it again.
 */
type ClaudeApartRunStop = (isEndWritten: boolean) => void;

/** The run-to-session routes of one `ClaudeSessionLifecycle`, in the order the runs were bound. */
export class ClaudeRunRoutes {
  readonly #sessionIdByRunId: Map<RunId, SessionId> = new Map();
  readonly #bindingByRunId: Map<RunId, ClaudeRunBinding> = new Map();
  readonly #childByRunId: Map<RunId, ClaudeChildRunRoute> = new Map();
  readonly #apartStopByRunId: Map<RunId, ClaudeApartRunStop> = new Map();
  // The sessions whose turn a command such as `/compact` holds, until that turn settles.
  readonly #commandTurnSessions: Set<SessionId> = new Set();
  // Who waits for a session's turn to be free, each answered once and dropped.
  readonly #turnWaitersBySession: Map<SessionId, Set<(isReleased: boolean) => void>> = new Map();

  /**
   * Resolves `true` once nothing holds the session's turn, at once when nothing does, or `false`
   * when `deadlineMs` passes first.
   */
  whenTurnReleased(sessionId: SessionId, deadlineMs: number): Promise<boolean> {
    if (!this.isTurnHeld(sessionId)) {
      return Promise.resolve(true);
    }
    const waiters = this.#turnWaitersBySession.get(sessionId) ?? new Set();
    this.#turnWaitersBySession.set(sessionId, waiters);
    return new Promise((resolve) => {
      const answer = (isReleased: boolean): void => {
        cancelDeadline();
        waiters.delete(answer);
        if (waiters.size === 0 && this.#turnWaitersBySession.get(sessionId) === waiters) {
          this.#turnWaitersBySession.delete(sessionId);
        }
        resolve(isReleased);
      };
      const cancelDeadline = scheduleUnrefTimer(() => {
        answer(false);
      }, deadlineMs);
      waiters.add(answer);
    });
  }

  /** Whether a run or a command holds the session's turn, so no other turn may start. */
  isTurnHeld(sessionId: SessionId): boolean {
    return this.#commandTurnSessions.has(sessionId) || this.runIdsBoundTo(sessionId).length > 0;
  }

  /**
   * Holds the session's turn for a command Claude Code runs as a turn of its own; the turn's
   * settlement releases it, as {@link retireRunRoutes} does.
   */
  holdTurnForCommand(sessionId: SessionId): void {
    this.#commandTurnSessions.add(sessionId);
  }

  /** Releases a command's hold whose text never reached Claude Code. */
  releaseCommandTurn(sessionId: SessionId): void {
    this.#commandTurnSessions.delete(sessionId);
    this.#answerTurnWaiters(sessionId);
  }

  /** Binds a run apart from its session's process to how it is stopped, until its turn ends. */
  bindApartRun(runId: RunId, stop: ClaudeApartRunStop): void {
    this.#apartStopByRunId.set(runId, stop);
  }

  /** Drops an apart run's route once its turn ended. */
  forgetApartRun(runId: RunId): void {
    this.#apartStopByRunId.delete(runId);
  }

  /**
   * Stops a run bound apart from its session's process, answering `false` for any other run;
   * `isEndWritten` as {@link bindApartRun}'s stop takes it.
   */
  stopApartRun(runId: RunId, isEndWritten: boolean): boolean {
    const stop = this.#apartStopByRunId.get(runId);
    if (stop === undefined) {
      return false;
    }
    this.#apartStopByRunId.delete(runId);
    stop(isEndWritten);
    return true;
  }

  /** Binds a helper's child run to its session and the agent id Claude Code gave it. */
  bindChildRun(runId: RunId, route: ClaudeChildRunRoute): void {
    this.#childByRunId.set(runId, route);
  }

  /** Drops a child run's route once its helper ended. */
  retireChildRun(runId: RunId): void {
    this.#childByRunId.delete(runId);
  }

  /** The child route of a helper's run, or `undefined` for a lead run or an unknown one. */
  childRouteFor(runId: RunId): ClaudeChildRunRoute | undefined {
    return this.#childByRunId.get(runId);
  }

  /** The child run of the helper Claude Code named `agentId` on a session, if one is bound. */
  childRunFor(sessionId: SessionId, agentId: string): RunId | undefined {
    for (const [runId, route] of this.#childByRunId) {
      if (route.sessionId === sessionId && route.agentId === agentId) {
        return runId;
      }
    }
    return undefined;
  }

  /** Drops every child route on a session whose process is gone; its helpers went with it. */
  retireChildRoutes(sessionId: SessionId): void {
    for (const [runId, route] of this.#childByRunId) {
      if (route.sessionId === sessionId) {
        this.#childByRunId.delete(runId);
      }
    }
  }

  /**
   * Binds a run to the session its opening frame goes to and the binding its deliveries are
   * attributed on; a rebind replaces both.
   */
  bindRun(runId: RunId, sessionId: SessionId, bindingId: string): void {
    this.#sessionIdByRunId.set(runId, sessionId);
    this.#bindingByRunId.set(runId, { sessionId, bindingId });
  }

  /**
   * Gives a run the session's turn again on the binding it already holds, as a paused run's next
   * turn does. Answers `false`, binding nothing, for a run the routes hold no binding for.
   */
  holdTurnAgain(runId: RunId, sessionId: SessionId): boolean {
    const binding = this.#bindingByRunId.get(runId);
    if (binding?.sessionId !== sessionId) {
      return false;
    }
    this.#sessionIdByRunId.set(runId, sessionId);
    return true;
  }

  /** Drops one run's turn hold; its binding stays until the run ends. */
  unbindRun(runId: RunId): void {
    const sessionId = this.#sessionIdByRunId.get(runId);
    this.#sessionIdByRunId.delete(runId);
    this.#answerTurnWaiters(sessionId);
  }

  /** Forgets an ended run: its turn hold and its binding. */
  forgetRun(runId: RunId): void {
    const sessionId = this.#sessionIdByRunId.get(runId);
    this.#sessionIdByRunId.delete(runId);
    this.#bindingByRunId.delete(runId);
    this.#answerTurnWaiters(sessionId);
  }

  /** The session a run's turn is bound to, or `undefined` when it holds no turn. */
  sessionIdFor(runId: RunId): SessionId | undefined {
    return this.#sessionIdByRunId.get(runId);
  }

  /** The binding a lead run's deliveries are attributed on, while the run has not ended. */
  bindingIdFor(runId: RunId): string | undefined {
    return this.#bindingByRunId.get(runId)?.bindingId;
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

  /** The run holding this session's turn with its binding, or `undefined` when none holds it. */
  leadRunOn(sessionId: SessionId): ClaudeBoundRun | undefined {
    const runId = this.soleLiveRunOn(sessionId);
    const bindingId = runId === null ? undefined : this.#bindingByRunId.get(runId)?.bindingId;
    return runId === null || bindingId === undefined ? undefined : { runId, bindingId };
  }

  /** Drops every turn hold on this session, a command's included; bindings and the slot stay. */
  retireRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
    this.#commandTurnSessions.delete(sessionId);
    this.#answerTurnWaiters(sessionId);
  }

  /** Forgets every run binding on a closed session, whose runs can deliver nothing more. */
  forgetSessionBindings(sessionId: SessionId): void {
    for (const [runId, binding] of this.#bindingByRunId) {
      if (binding.sessionId === sessionId) {
        this.#bindingByRunId.delete(runId);
      }
    }
  }

  #answerTurnWaiters(sessionId: SessionId | undefined): void {
    if (sessionId === undefined || this.isTurnHeld(sessionId)) {
      return;
    }
    const waiters = this.#turnWaitersBySession.get(sessionId);
    this.#turnWaitersBySession.delete(sessionId);
    for (const answer of waiters ?? []) {
      answer(true);
    }
  }
}
