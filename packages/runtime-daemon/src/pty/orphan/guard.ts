// What the terminal host reports each child's life to, so that no child outlives the daemon
// unreaped: the intent before the start, the process after it, and the end. The guard opens by
// sweeping what a previous run left, so the registry holds only this run's children.

import { randomBytes } from "node:crypto";

import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import pidtree from "pidtree";

import { withCleanupFailures } from "../../cleanup-failures.js";
import type { OrphanOperatingSystem, ProcessExitWatch } from "./operating-system.js";
import { OrphanRegistry } from "./registry.js";
import { sweepOrphans, type OrphanSweepResult } from "./sweep.js";

/** What a guard is built over. */
export interface OrphanGuardOptions {
  registry: OrphanRegistry;
  /** This boot's id, which every entry records. */
  bootId: string;
  readProcessIdentity: (processId: number) => Promise<ProcessIdentity | undefined>;
  exitWatch?: ProcessExitWatch | undefined;
  writeServiceLog: (line: string) => void;
}

/**
 * Records each terminal child in the orphan registry across its life. A child is retired when the
 * host sees it end or, where the system watches exits, when the kernel reports it, whichever is
 * first; a child closed but still running stays recorded.
 */
export class OrphanGuard {
  readonly #registry: OrphanRegistry;
  readonly #bootId: string;
  readonly #readProcessIdentity: (processId: number) => Promise<ProcessIdentity | undefined>;
  readonly #exitWatch: ProcessExitWatch | undefined;
  readonly #writeServiceLog: (line: string) => void;

  constructor(options: OrphanGuardOptions) {
    this.#registry = options.registry;
    this.#bootId = options.bootId;
    this.#readProcessIdentity = options.readProcessIdentity;
    this.#exitWatch = options.exitWatch;
    this.#writeServiceLog = options.writeServiceLog;
  }

  /** Durably records that a child is about to start, and answers the nonce it must carry. */
  async prepareSpawn(): Promise<string> {
    // Random, so no other process carries it by chance.
    const nonce = randomBytes(16).toString("hex");
    await this.#registry.recordIntent(nonce, this.#bootId);
    return nonce;
  }

  /**
   * Records the started child and watches it for its end. Rejects when it cannot record it, and
   * the caller then kills the child, so no child runs unrecorded; a watch the system refuses goes
   * to the service log, and the recorded child is kept.
   */
  async completeSpawn(nonce: string, processId: number): Promise<void> {
    const identity = await this.#readProcessIdentity(processId);
    // The child has already ended, so there is nothing to record.
    if (identity === undefined) {
      this.retire(nonce);
      return;
    }
    await this.#registry.recordChild(nonce, {
      processId,
      processStartTime: identity.processStartTime,
    });
    try {
      this.#exitWatch?.watch(processId, () => {
        this.retire(nonce);
      });
    } catch (error) {
      // The registry already holds the child, so the next start's sweep still finds it.
      this.#writeServiceLog(
        `The kernel would not watch terminal child ${String(processId)} for its exit: ` +
          describeError(error),
      );
    }
  }

  /** Forgets a child that has ended. A failed write goes to the service log. */
  retire(nonce: string): void {
    this.#registry.retire(nonce).catch((error: unknown) => {
      this.#writeServiceLog(
        `The orphan registry could not forget an ended terminal child: ${describeError(error)}`,
      );
    });
  }

  /** Stops the exit watch and waits for every registry write asked for so far. */
  async close(): Promise<void> {
    await this.#exitWatch?.close();
    await this.#registry.whenWritten();
  }
}

/** What opening a guard needs. */
export interface OrphanGuardOpening {
  dataFolder: string;
  bootId: string;
  readProcessIdentity: (processId: number) => Promise<ProcessIdentity | undefined>;
  operatingSystem: OrphanOperatingSystem;
  writeServiceLog: (line: string) => void;
}

/**
 * Sweeps what a previous run left in the data folder's registry, empties it, and answers a guard
 * over it with what the sweep did. Throws when a kill or the registry's write fails, after closing
 * the system's exit watch.
 */
export async function openOrphanGuard(
  opening: OrphanGuardOpening,
): Promise<{ guard: OrphanGuard; sweep: OrphanSweepResult }> {
  const registry = new OrphanRegistry(opening.dataFolder);
  let sweep: OrphanSweepResult;
  try {
    sweep = await sweepOrphans(await registry.readLeftover(), {
      bootId: opening.bootId,
      readProcessIdentity: opening.readProcessIdentity,
      findProcessesCarryingNonces: opening.operatingSystem.findProcessesCarryingNonces,
      listDescendants: listDescendantProcesses,
      killProcess: (processId) => {
        process.kill(processId, "SIGKILL");
      },
    });
    await registry.forget();
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await opening.operatingSystem.exitWatch?.close();
    } catch (closeFailure) {
      cleanupFailures.push(closeFailure);
    }
    throw withCleanupFailures(error, cleanupFailures, "The orphan sweep");
  }
  const guard = new OrphanGuard({
    registry,
    bootId: opening.bootId,
    readProcessIdentity: opening.readProcessIdentity,
    exitWatch: opening.operatingSystem.exitWatch,
    writeServiceLog: opening.writeServiceLog,
  });
  return { guard, sweep };
}

async function listDescendantProcesses(processId: number): Promise<number[]> {
  try {
    return await pidtree(processId);
  } catch (error) {
    // `pidtree` refuses an id the process list no longer holds: the process has ended.
    if (error instanceof Error && error.message === "No matching pid found") {
      return [];
    }
    throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
