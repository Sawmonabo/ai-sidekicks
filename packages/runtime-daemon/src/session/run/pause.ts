// Pause and resume of a live run: each refused unless the caller read the run's current version,
// the move written under the same version guard, and only then the driver asked to make it true
// on the provider. A refusal leaves the run exactly as it was.

import type {
  RunControlAck,
  RunPauseRequest,
  RunResumeRequest,
} from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import { WriteRefusedError } from "../../database/writer.js";
import { runAtVersionStatement } from "../../interventions/store.js";
import { KeyedLock } from "../../keyed-lock.js";
import type { ProviderDriver } from "../../provider/driver/contract.js";
import type { WaitingMessage } from "../../provider/driver/run-control.js";
import type { RunEngine } from "./engine.js";
import type { RunRead, RunStateReader } from "./read.js";
import { RunInvalidTransitionError, RunNotFoundError, RunVersionStaleError } from "./refusals.js";

// A non-terminal change's write runs the run's swap first and its companions after it, so the
// version guard is the second statement.
const VERSION_GUARD_INDEX = 1;

// The states a resume continues: a run still finishing its step, or one already stopped.
const RESUMABLE_STATES: readonly RunState[] = ["pausing", "paused"];

/** What pause and resume read and write through. */
export interface RunPauseControlDeps {
  readonly runs: Pick<RunStateReader, "getRun">;
  readonly engine: Pick<RunEngine, "transition">;
}

/** A guarded pause or resume of one run, at the version the caller read. */
interface GuardedRequest {
  readonly targetRunId: RunId;
  readonly expectedRunVersion: number;
}

/**
 * Pauses and resumes runs. Calls on one run take turns, so a resume never reaches the driver
 * before the pause it follows.
 */
export class RunPauseControl {
  readonly #runs: Pick<RunStateReader, "getRun">;
  readonly #engine: Pick<RunEngine, "transition">;
  readonly #runLock = new KeyedLock<RunId>(canonicalizeUuid);

  constructor(deps: RunPauseControlDeps) {
    this.#runs = deps.runs;
    this.#engine = deps.engine;
  }

  /**
   * Moves a running run to `pausing`, then asks the driver to stop it after the step in flight;
   * the driver reports `paused`. Throws {@link RunVersionStaleError} when `expectedRunVersion` is
   * not the run's version and {@link RunInvalidTransitionError} for a run that is not running. A
   * pause the driver refuses returns the run to `running` and throws the driver's error.
   */
  async pause(
    request: RunPauseRequest,
    driver: Pick<ProviderDriver, "pauseRun">,
  ): Promise<RunControlAck> {
    return this.#runLock.run(request.targetRunId, async () => {
      const { targetRunId: runId } = request;
      const run = this.#readAtExpectedVersion(request);
      const pausing = await this.#moveAtExpectedVersion(request, "pausing");
      try {
        await driver.pauseRun({ sessionId: run.sessionId, runId });
      } catch (driverError) {
        await this.#restoreRunning(runId, driverError);
        throw driverError;
      }
      return { runId, newState: pausing.state, runVersion: pausing.version };
    });
  }

  /**
   * Moves a pausing or paused run back to `running` on the same run id, then asks the driver to
   * continue it from where it stopped, delivering `messages` in send order. Throws
   * {@link RunVersionStaleError} when `expectedRunVersion` is not the run's version and
   * {@link RunInvalidTransitionError} for a run in any other state; the driver's own failure is
   * thrown with the run left `running`.
   */
  async resume(
    request: RunResumeRequest,
    driver: Pick<ProviderDriver, "resumeRun">,
    messages: readonly WaitingMessage[],
  ): Promise<RunControlAck> {
    return this.#runLock.run(request.targetRunId, async () => {
      const { targetRunId: runId } = request;
      const run = this.#readAtExpectedVersion(request);
      if (!RESUMABLE_STATES.includes(run.state)) {
        throw new RunInvalidTransitionError(runId, run.state, "running");
      }
      const running = await this.#moveAtExpectedVersion(request, "running");
      await driver.resumeRun({ sessionId: run.sessionId, runId, messages });
      return { runId, newState: running.state, runVersion: running.version };
    });
  }

  // Any mismatch is refused, an older version or one no honest caller can hold yet.
  #readAtExpectedVersion(request: GuardedRequest): RunRead {
    const run = this.#runs.getRun(request.targetRunId);
    if (run === undefined) {
      throw new RunNotFoundError(request.targetRunId);
    }
    if (run.version !== request.expectedRunVersion) {
      throw new RunVersionStaleError(request.targetRunId, request.expectedRunVersion, run.version);
    }
    return run;
  }

  // The guard sits in the move's own write, so a run that moved after the read is refused there
  // rather than moved from its new version.
  async #moveAtExpectedVersion(
    request: GuardedRequest,
    newState: "pausing" | "running",
  ): Promise<RunRead> {
    const { targetRunId: runId, expectedRunVersion } = request;
    try {
      return await this.#engine.transition(
        { runId, newState },
        { statements: [runAtVersionStatement(runId, expectedRunVersion + 1)] },
      );
    } catch (error) {
      if (error instanceof WriteRefusedError && error.statementIndex === VERSION_GUARD_INDEX) {
        const now = this.#runs.getRun(runId);
        if (now === undefined) {
          throw new RunNotFoundError(runId);
        }
        throw new RunVersionStaleError(runId, expectedRunVersion, now.version);
      }
      throw error;
    }
  }

  // A run that left `pausing` while the driver was asked keeps where it went.
  async #restoreRunning(runId: RunId, driverError: unknown): Promise<void> {
    try {
      await this.#engine.transition({ runId, expectedState: "pausing", newState: "running" });
    } catch (restoreError) {
      if (
        restoreError instanceof RunInvalidTransitionError &&
        restoreError.fromState !== "pausing"
      ) {
        return;
      }
      throw new AggregateError(
        [driverError, restoreError],
        `The driver refused to pause run ${runId}, and returning the run to running failed`,
        { cause: restoreError },
      );
    }
  }
}
