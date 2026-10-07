// The start's sweep over what a previous run of the daemon left in the orphan registry: every
// child still running from that run is killed with everything under it, and every other entry is
// discarded. A kill needs proof the process is the child: the same boot, id and start for a
// started child, or the child's nonce in its environment for one only intended. Anything short of
// proof is discarded and nothing is signaled, so the sweep never kills a stranger.

import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import { isSameProcess } from "@ai-sidekicks/contracts/process-identity";

import type { OrphanRegistryEntry, OrphanRegistryLeftover } from "./registry.js";

/** How the sweep reads and signals the system; each is handed in so a test can stand in. */
export interface OrphanSweepSystem {
  /** This boot's id; an entry from another boot names a process that cannot still run. */
  readonly bootId: string;
  /** Reads a process by id, or `undefined` when no process has it. */
  readonly readProcessIdentity: (processId: number) => Promise<ProcessIdentity | undefined>;
  /** Finds this user's processes carrying a nonce, where the system shows their environments. */
  readonly findProcessesCarryingNonce?: ((nonce: string) => Promise<number[]>) | undefined;
  /** Lists every process under one, not the process itself; none when the process is gone. */
  readonly listDescendants: (processId: number) => Promise<number[]>;
  /** Kills one process outright; throws as `process.kill` does, `ESRCH` when it is gone. */
  readonly killProcess: (processId: number) => void;
}

/** What the sweep did, counted in registry entries. */
export interface OrphanSweepResult {
  /** Entries whose child was still running and was killed, with everything under it. */
  killed: number;
  /** Entries discarded with nothing signaled. */
  discarded: number;
  /** Why the registry file could not be trusted, when it could not; then nothing was signaled. */
  unreadableCause?: string | undefined;
}

/**
 * Kills each child a previous run left running and discards every other entry. A kill that fails
 * for any reason but the process being gone throws, so the start fails rather than skip a child.
 */
export async function sweepOrphans(
  leftover: OrphanRegistryLeftover,
  system: OrphanSweepSystem,
): Promise<OrphanSweepResult> {
  let killed = 0;
  for (const entry of leftover.entries) {
    if (await killLeftoverChild(entry, system)) {
      killed += 1;
    }
  }
  return {
    killed,
    discarded: leftover.entries.length - killed,
    unreadableCause: leftover.unreadableCause,
  };
}

/** The sweep as one service-log line. */
export function describeOrphanSweep(result: OrphanSweepResult): string {
  const counts =
    `The terminal children a previous run left: ${String(result.killed)} killed, ` +
    `${String(result.discarded)} discarded`;
  return result.unreadableCause === undefined
    ? `${counts}.`
    : `${counts}; the orphan registry was discarded unread because ${result.unreadableCause}.`;
}

async function killLeftoverChild(
  entry: OrphanRegistryEntry,
  system: OrphanSweepSystem,
): Promise<boolean> {
  // A reboot ended every process of the earlier boot, and any process now holding a recorded id is
  // a stranger.
  if (entry.bootId !== system.bootId) {
    return false;
  }
  if (entry.child !== undefined) {
    const recorded: ProcessIdentity = { ...entry.child, bootId: entry.bootId };
    const current = await system.readProcessIdentity(recorded.processId);
    if (current === undefined || !isSameProcess(recorded, current)) {
      return false;
    }
    return killTree(recorded.processId, system);
  }
  // Only the intent was recorded, so the child, if it started, is known by its nonce alone.
  if (system.findProcessesCarryingNonce === undefined) {
    return false;
  }
  let isAnyKilled = false;
  for (const processId of await system.findProcessesCarryingNonce(entry.nonce)) {
    if (await killTree(processId, system)) {
      isAnyKilled = true;
    }
  }
  return isAnyKilled;
}

// Lists the descendants first, since once the root dies they move to the system's first process
// and can no longer be found under it. Answers whether the root was still there to kill.
async function killTree(rootProcessId: number, system: OrphanSweepSystem): Promise<boolean> {
  for (const processId of await system.listDescendants(rootProcessId)) {
    killIfPresent(processId, system);
  }
  return killIfPresent(rootProcessId, system);
}

function killIfPresent(processId: number, system: OrphanSweepSystem): boolean {
  try {
    system.killProcess(processId);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
