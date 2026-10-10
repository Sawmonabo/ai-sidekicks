// The run routes of the Codex leg: which session each run's live turns are on, the runtime binding
// and agent each run's deliveries are attributed on, and the level a run alone was asked to run
// at, until the run ends.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { type CodexSessionRecord, newestActiveTurnForRun } from "../session/state.js";

/** The binding a run's deliveries go on and the agent whose run it is. */
export interface CodexRunBinding {
  readonly sessionId: SessionId;
  readonly bindingId: string;
  readonly agentId: AgentId;
}

/** The run routes of one `CodexLifecycleManager`. */
export class CodexRunRoutes {
  readonly #sessionIdByRunId = new Map<RunId, SessionId>();
  readonly #bindingByRunId = new Map<RunId, CodexRunBinding>();
  readonly #outputSpeedForTurnByRunId = new Map<RunId, string>();
  readonly #turnStartWaiters = new Map<RunId, (turnId: string) => void>();

  /** Routes a run to the session whose turn `turnId` just started. */
  bindRun(runId: RunId, sessionId: SessionId, turnId: string): void {
    this.#sessionIdByRunId.set(runId, sessionId);
    const waiter = this.#turnStartWaiters.get(runId);
    this.#turnStartWaiters.delete(runId);
    waiter?.(turnId);
  }

  /**
   * Calls `onTurnStarted` with the turn once `runId` is routed to one, for a turn Codex starts on
   * its own after a request whose reply names no turn. The returned function stops waiting.
   */
  awaitTurnStart(runId: RunId, onTurnStarted: (turnId: string) => void): () => void {
    this.#turnStartWaiters.set(runId, onTurnStarted);
    return () => {
      if (this.#turnStartWaiters.get(runId) === onTurnStarted) {
        this.#turnStartWaiters.delete(runId);
      }
    };
  }

  /**
   * Records the binding a run's deliveries go on, before its first turn is sent; it stays until
   * the run ends, through every turn the run takes.
   */
  bindRunDelivery(runId: RunId, binding: CodexRunBinding): void {
    this.#bindingByRunId.set(runId, binding);
  }

  /** The binding a run's deliveries go on, or `undefined` once the run ended. */
  bindingFor(runId: RunId): CodexRunBinding | undefined {
    return this.#bindingByRunId.get(runId);
  }

  /** The binding id a run's deliveries go on, or `undefined` once the run ended. */
  bindingIdFor(runId: RunId): string | undefined {
    return this.#bindingByRunId.get(runId)?.bindingId;
  }

  /** Keeps the output speed a run alone was asked to run at, for every turn it takes. */
  keepOutputSpeedForTurn(runId: RunId, outputSpeedForTurn: string): void {
    this.#outputSpeedForTurnByRunId.set(runId, outputSpeedForTurn);
  }

  /** The output speed a run alone was asked to run at; `undefined` when it runs at the session's. */
  outputSpeedForTurnOf(runId: RunId): string | undefined {
    return this.#outputSpeedForTurnByRunId.get(runId);
  }

  /** Forgets a run that ended, so nothing more is delivered for it. */
  forgetRun(runId: RunId): void {
    this.#bindingByRunId.delete(runId);
    this.#outputSpeedForTurnByRunId.delete(runId);
  }

  /** The session a run is routed to, or `undefined` once its last route is retired. */
  sessionIdFor(runId: RunId): SessionId | undefined {
    return this.#sessionIdByRunId.get(runId);
  }

  /**
   * Retires one turn's route, and the run's session binding only when that turn was the run's
   * last: dropping it earlier would strand the steer and interrupt paths of the run's other live
   * turn.
   */
  retireTurnRoute(record: CodexSessionRecord, turnId: string): void {
    const runId = record.runIdByActiveTurnId.get(turnId);
    if (runId === undefined) {
      return;
    }
    record.runIdByActiveTurnId.delete(turnId);
    if (newestActiveTurnForRun(record, runId) === undefined) {
      this.#sessionIdByRunId.delete(runId);
    }
  }

  /**
   * Drops every run route and binding of a session, scanning by value: the record that could
   * enumerate them is gone or replaced by the time a sweep is owed.
   */
  forgetRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
    for (const [runId, binding] of this.#bindingByRunId) {
      if (binding.sessionId === sessionId) {
        this.#bindingByRunId.delete(runId);
      }
    }
  }
}
