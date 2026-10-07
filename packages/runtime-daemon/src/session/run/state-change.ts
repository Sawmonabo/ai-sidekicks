// One run state change, written whole: the check against the table, the event, the row's swap
// and, for a terminal, the guard that the run version holds no terminal record yet, all in one
// write so they commit together or not at all.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type {
  RunStateChangePayload,
  RunStateChangeState,
} from "@ai-sidekicks/contracts/run/events";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";

import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError } from "../../database/writer.js";
import type { SessionEventAppender, SessionEventDraft } from "../../events/session/appender.js";
import { swapRunStateStatement } from "./projection.js";
import type { RunRead, RunStateReader } from "./read.js";
import { RunAlreadyEndedError, RunInvalidTransitionError, RunNotFoundError } from "./refusals.js";
import { RUN_TERMINAL_STATES, isTerminalState, isTransitionAllowed } from "./transitions.js";

type RunStateChangeMembers<TState extends RunStateChangeState> = Omit<
  RunStateChangePayload<TState>,
  "sessionId" | "runId" | "runVersion" | "previousState" | "newState"
>;

/**
 * One state change asked of a run: the state it enters and what that state's event carries. With
 * `expectedState`, the change is refused unless the run is in that state when it is read.
 */
export type RunStateChange = {
  [TState in RunStateChangeState]: {
    readonly runId: RunId;
    readonly newState: TState;
    readonly expectedState?: RunState | undefined;
  } & RunStateChangeMembers<TState>;
}[RunStateChangeState];

// Spelled as the unique index on terminal records spells its predicate, so the read uses it.
const SELECT_TERMINAL_RECORD_SQL = `SELECT 1 FROM session_events
  WHERE category = 'run_lifecycle'
    AND type IN (${RUN_TERMINAL_STATES.map((state) => `'run.${state}'`).join(", ")})
    AND json_extract(payload, '$.runId') = @run_id
    AND json_extract(payload, '$.runVersion') = @run_version
  LIMIT 1`;

/**
 * What commits with a run state change in its write: statements run after the run's swap, so one
 * that reads the run sees the version the change reached, and events appended just before the
 * change's own. A statement refusing refuses the whole write.
 */
export interface RunStateChangeCompanions {
  readonly statements?: readonly WriteStatement[] | undefined;
  readonly precedingEvents?: readonly SessionEventDraft[] | undefined;
}

// How many times a change is read and written before a run that keeps moving under it is refused.
const MAX_WRITE_ATTEMPTS = 3;

// A terminal write's statements, in order: the guard, the swap, then the companion statements;
// any other change's start at the swap.
const TERMINAL_GUARD_INDEX = 0;

/** Writes run state changes; the run's row and its event move in the same write. */
export class RunStateChangeWriter {
  readonly #runs: RunStateReader;
  readonly #appender: SessionEventAppender;

  constructor(runs: RunStateReader, appender: SessionEventAppender) {
    this.#runs = runs;
    this.#appender = appender;
  }

  /**
   * Writes `change` from the run's current row and resolves with the run as it left it. A run that
   * moved after it was read is read again and the change retried while the table still allows it
   * and the run has not ended, up to a few times. Throws {@link RunNotFoundError} for an unknown run,
   * {@link RunAlreadyEndedError} for a terminal of a run that has ended or whose run version already
   * holds one, and {@link RunInvalidTransitionError} for a move the table does not allow from the
   * state the run is in; a companion statement refusing throws its `WriteRefusedError`. Each
   * refusal writes nothing.
   */
  async write(change: RunStateChange, companions: RunStateChangeCompanions = {}): Promise<RunRead> {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.#attempt(change, companions, attempt > 1);
      if (outcome.written !== undefined) {
        return outcome.written;
      }
      if (attempt === MAX_WRITE_ATTEMPTS) {
        throw outcome.swapRefusal;
      }
    }
  }

  // One read and one write; a swap the run moved under comes back to be retried from a fresh read.
  // A retry never starts from an ended run: re-opening one is the daemon's own decision, made on a
  // first read, never a change that lost its race to the run's end.
  async #attempt(
    change: RunStateChange,
    companions: RunStateChangeCompanions,
    isRetry: boolean,
  ): Promise<{ written: RunRead; swapRefusal?: never } | { written?: never; swapRefusal: Error }> {
    const { runId, newState, expectedState, ...members } = change;
    const run = this.#runs.getRun(runId);
    if (run === undefined) {
      throw new RunNotFoundError(runId);
    }
    if (
      (expectedState !== undefined && run.state !== expectedState) ||
      !isTransitionAllowed(run.state, newState) ||
      (isRetry && isTerminalState(run.state))
    ) {
      throw isTerminalState(run.state) && isTerminalState(newState)
        ? new RunAlreadyEndedError(runId, run.state, newState)
        : new RunInvalidTransitionError(runId, run.state, newState);
    }

    const runVersion = run.version + 1;
    const swap = swapRunStateStatement({
      sessionId: run.sessionId,
      runId,
      previousState: run.state,
      newState,
      runVersion,
    });
    const isTerminal = isTerminalState(newState);
    const companionStatements = companions.statements ?? [];
    const transactionalPrelude = isTerminal
      ? [noTerminalRecordStatement(runId, runVersion), swap, ...companionStatements]
      : [swap, ...companionStatements];
    const swapIndex = transactionalPrelude.indexOf(swap);
    const type: SessionEventType = `run.${newState}`;
    const payload = {
      ...members,
      sessionId: run.sessionId,
      runId,
      runVersion,
      previousState: run.state,
      newState,
    };
    try {
      await this.#appender.append(type, payload, {
        transactionalPrelude,
        precedingEvents: companions.precedingEvents,
      });
    } catch (error) {
      if (!(error instanceof WriteRefusedError)) {
        throw error;
      }
      if (isTerminal && error.statementIndex === TERMINAL_GUARD_INDEX) {
        throw new RunAlreadyEndedError(runId, run.state, newState, { cause: error });
      }
      if (error.statementIndex === swapIndex) {
        return { swapRefusal: this.#movedRunRefusal(error, runId, newState) };
      }
      throw error;
    }
    return { written: { version: runVersion, sessionId: run.sessionId, state: newState } };
  }

  // A swap refused because the run moved after it was read: a terminal meeting an ended run is
  // refused as already ended, and any other change from the state the run moved to.
  #movedRunRefusal(
    refusal: WriteRefusedError,
    runId: RunId,
    newState: RunStateChangeState,
  ): RunInvalidTransitionError | RunNotFoundError {
    const now = this.#runs.getRun(runId);
    if (now === undefined) {
      return new RunNotFoundError(runId);
    }
    return isTerminalState(newState) && isTerminalState(now.state)
      ? new RunAlreadyEndedError(runId, now.state, newState, { cause: refusal })
      : new RunInvalidTransitionError(runId, now.state, newState, { cause: refusal });
  }
}

// Reads the log inside the write, so no read outside the write decides a terminal.
function noTerminalRecordStatement(runId: RunId, runVersion: number): WriteStatement {
  return {
    sql: SELECT_TERMINAL_RECORD_SQL,
    bindings: { run_id: runId, run_version: runVersion },
    expectedRowCount: 0,
  };
}
