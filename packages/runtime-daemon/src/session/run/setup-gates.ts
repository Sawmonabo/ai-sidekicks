// The checks a run passes between admission and its provider's start, and the hooks that release
// what they hold once the run ends.

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { RunTerminalState } from "./transitions.js";

/** The run a setup gate checks; its workspace is read from its session, never from the item. */
export interface RunSetupContext {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly queueItem: QueueItemSummary;
}

/** How a run ended, handed to every terminal hook as the cause of what it releases. */
export interface RunTerminalContext {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly terminalState: RunTerminalState;
  readonly runVersion: number;
}

/**
 * A check a run must pass in `starting` before its provider starts it. A throw from
 * `assertRunReady` parks the run in `starting`; `onRunTerminal` runs once for each run version
 * that ends, whatever ended it.
 */
export interface RunSetupGate {
  assertRunReady(context: RunSetupContext): Promise<void>;
  onRunTerminal?(context: RunTerminalContext): Promise<void>;
}

/** A run left in `starting` because a setup gate threw; `cause` is what the gate threw. */
export class RunParkedInSetupError extends Error {
  readonly runId: RunId;

  constructor(runId: RunId, cause: unknown) {
    super("A setup gate refused the run, so it waits in starting", { cause });
    this.name = "RunParkedInSetupError";
    this.runId = runId;
  }
}

/** The registered gates, in registration order; one entry per gate a feature registers at boot. */
export class RunSetupGates {
  readonly #gates: RunSetupGate[] = [];

  register(gate: RunSetupGate): void {
    this.#gates.push(gate);
  }

  /** Runs every gate in registration order; throws {@link RunParkedInSetupError} at the first throw. */
  async assertRunReady(context: RunSetupContext): Promise<void> {
    for (const gate of this.#gates) {
      try {
        await gate.assertRunReady(context);
      } catch (error) {
        throw new RunParkedInSetupError(context.runId, error);
      }
    }
  }

  /**
   * Runs every terminal hook in reverse registration order. A hook that throws does not stop the
   * rest; once all have run, their errors are thrown together as one `AggregateError`.
   */
  async releaseForTerminal(context: RunTerminalContext): Promise<void> {
    const failures: unknown[] = [];
    for (const gate of this.#gates.toReversed()) {
      try {
        await gate.onRunTerminal?.(context);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `A terminal hook failed after run ${context.runId} ended ${context.terminalState}`,
      );
    }
  }
}
