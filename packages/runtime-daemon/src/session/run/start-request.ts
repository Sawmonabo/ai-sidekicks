// What the run engine is handed to start a run: a send's run with its admitted item, or a turn the
// daemon or the provider starts on a session as the session's own run.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { WorkspaceId } from "@ai-sidekicks/contracts/repo/mount";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";

/**
 * What the engine's `startRun` needs: the admitted item, its provider, and the start of the run on
 * that provider.
 */
export interface RunStartRequest {
  readonly runId: RunId;
  readonly queueItem: QueueItemSummary;
  /** The workspace the send that started the run bound it to; absent where none was named. */
  readonly workspaceId?: WorkspaceId | undefined;
  /** The provider the run runs on; its settled output speed is read against this one's standard. */
  readonly provider: ProviderName;
  /** The output speed the run starts at, held until its provider reports the speed settled. */
  readonly outputSpeed: string | undefined;
  /**
   * The posture the run was requested at; the posture gate checks it, and its resolved form is what
   * the driver is handed and `run.running` is stamped with.
   */
  readonly executionPosture: ExecutionPosture;
  /** Starts the run on its provider at the resolved posture, once every setup gate has passed. */
  readonly startDriver: (resolvedPosture: ExecutionPosture) => Promise<void>;
  /**
   * Ends the provider's turn `startDriver` started through the driver's interrupt, when the run's
   * `running` write fails after it, so no turn runs on for a run that cannot record it.
   */
  readonly interruptDriver: () => Promise<void>;
}

/**
 * What the engine's `startDaemonTurn` needs: the session whose own run the turn is, the account
 * its process was admitted against, the posture it runs at, and the driver's start of the turn.
 */
export interface DaemonTurnStartRequest {
  readonly sessionId: SessionId;
  readonly provider: ProviderName;
  /** The account the session's process was admitted against, or `null` for none. */
  readonly admittedProviderAccountId: string | null;
  /** The session's current level and roots, which the turn runs at like any run. */
  readonly executionPosture: ExecutionPosture;
  /**
   * Whether the provider started the turn itself: its run takes over, in its `running` write, the
   * lead messages waiting for an interrupted run. A turn the daemon starts waits for the continue
   * of an interrupted run the session holds its turn for.
   */
  readonly isProviderStarted: boolean;
  /**
   * Whether the turn runs in a process of its own apart from the session's, such as Claude Code's
   * review of the staged set: it takes no turn of the session's process, so its run is no lead run
   * and nothing the session's turn waits for holds it back.
   */
  readonly isApart?: boolean;
  /**
   * The driver's start of the turn under the new run's id: it binds the run and writes the turn's
   * opening, and resolves once it is written. A throw ends the run `failed`.
   */
  readonly startTurn: (runId: RunId) => Promise<void>;
  /**
   * Ends the turn `startTurn` started under the run's id through the driver's interrupt, when the
   * run's `running` write fails after it.
   */
  readonly interruptTurn: (runId: RunId) => Promise<void>;
}

/**
 * How one start reaches its driver, handed the run's resolved posture, the posture requested, and
 * the statements that go in the run's `running` write, built when it is written.
 */
export interface RunStartPath extends Omit<RunStartRequest, "runId" | "queueItem" | "workspaceId"> {
  readonly runningStatements?: (() => readonly WriteStatement[]) | undefined;
}
