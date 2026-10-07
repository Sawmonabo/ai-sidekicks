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
import type { SessionEventAppender } from "../../events/session/appender.js";
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

// A terminal write's statements, in order: the guard, the swap, then the caller's own guards.
const TERMINAL_GUARD_INDEX = 0;
const TERMINAL_SWAP_INDEX = 1;

/** Writes run state changes; the run's row and its event move in the same write. */
export class RunStateChangeWriter {
  readonly #runs: RunStateReader;
  readonly #appender: SessionEventAppender;

  constructor(runs: RunStateReader, appender: SessionEventAppender) {
    this.#runs = runs;
    this.#appender = appender;
  }

  /**
   * Writes `change` from the run's current row and resolves with the run as it left it; any of
   * `extraGuards` refusing refuses the whole write. Throws {@link RunNotFoundError} for an unknown
   * run, {@link RunAlreadyEndedError} for a terminal the run version already holds, and
   * {@link RunInvalidTransitionError} for a move the table does not allow, writing nothing.
   */
  async write(
    change: RunStateChange,
    extraGuards: readonly WriteStatement[] = [],
  ): Promise<RunRead> {
    const { runId, newState, expectedState, ...members } = change;
    const run = this.#runs.getRun(runId);
    if (run === undefined) {
      throw new RunNotFoundError(runId);
    }
    if (
      (expectedState !== undefined && run.state !== expectedState) ||
      !isTransitionAllowed(run.state, newState)
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
    const transactionalPrelude = isTerminal
      ? [noTerminalRecordStatement(runId, runVersion), swap, ...extraGuards]
      : [swap, ...extraGuards];
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
      await this.#appender.append(type, payload, { transactionalPrelude });
    } catch (error) {
      if (isTerminal && error instanceof WriteRefusedError) {
        throw this.#endedRunRefusal(error, runId, run.state, newState) ?? error;
      }
      throw error;
    }
    return { version: runVersion, sessionId: run.sessionId, state: newState };
  }

  // A terminal refused by its guard met a terminal record; one refused by its swap met a run that
  // moved, which is an ended run only when the run now reads ended.
  #endedRunRefusal(
    refusal: WriteRefusedError,
    runId: RunId,
    readState: RunState,
    newState: RunStateChangeState,
  ): RunAlreadyEndedError | undefined {
    if (refusal.statementIndex === TERMINAL_GUARD_INDEX) {
      return new RunAlreadyEndedError(runId, readState, newState, { cause: refusal });
    }
    if (refusal.statementIndex === TERMINAL_SWAP_INDEX) {
      const now = this.#runs.getRun(runId);
      if (now !== undefined && isTerminalState(now.state)) {
        return new RunAlreadyEndedError(runId, now.state, newState, { cause: refusal });
      }
    }
    return undefined;
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
