// The start's sweep over what a previous run of the daemon left in the orphan registry: every
// child still running from that run is killed with everything under it, and every other entry is
// discarded. A kill needs proof the process is the child or its own: the same boot, id and start
// for a started child, or the child's nonce in its environment, which a descendant that left the
// child's tree still carries. Each process is read again right before its signal and signaled
// only when it is still the one first read, so the sweep never kills a stranger.

import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import { isSameProcess } from "@ai-sidekicks/contracts/process-identity";

import type { OrphanRegistryLeftover } from "./registry.js";

/** How the sweep reads and signals the system; each is handed in so a test can stand in. */
export interface OrphanSweepSystem {
  /** This boot's id; an entry from another boot names a process that cannot still run. */
  readonly bootId: string;
  /** Reads a process by id, or `undefined` when no process has it. */
  readonly readProcessIdentity: (processId: number) => Promise<ProcessIdentity | undefined>;
  /**
   * Finds this user's processes carrying one of `nonces`, by process id, where the system shows
   * their environments.
   */
  readonly findProcessesCarryingNonces?:
    | ((nonces: ReadonlySet<string>) => Promise<Map<number, string>>)
    | undefined;
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
  // A reboot ended every process of the earlier boot, and any process now holding a recorded id is
  // a stranger, so only this boot's entries are looked at.
  const entries = leftover.entries.filter((entry) => entry.bootId === system.bootId);
  const carriers =
    (await system.findProcessesCarryingNonces?.(new Set(entries.map((entry) => entry.nonce)))) ??
    new Map<number, string>();
  let killed = 0;
  for (const entry of entries) {
    const targets = new Map<number, ProcessIdentity>();
    if (entry.child !== undefined) {
      const recorded: ProcessIdentity = { ...entry.child, bootId: entry.bootId };
      const current = await system.readProcessIdentity(recorded.processId);
      if (current !== undefined && isSameProcess(recorded, current)) {
        await addTree(recorded, system, targets);
      }
    }
    for (const [processId, nonce] of carriers) {
      if (nonce !== entry.nonce || targets.has(processId)) {
        continue;
      }
      const carrier = await system.readProcessIdentity(processId);
      if (carrier !== undefined) {
        await addTree(carrier, system, targets);
      }
    }
    if (await killStillSame(targets, system)) {
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

// Adds the process and everything under it, each as read now; the descendants come first, since
// once the root dies they move to the system's first process and can no longer be found under it.
async function addTree(
  root: ProcessIdentity,
  system: OrphanSweepSystem,
  targets: Map<number, ProcessIdentity>,
): Promise<void> {
  for (const processId of await system.listDescendants(root.processId)) {
    if (targets.has(processId)) {
      continue;
    }
    const descendant = await system.readProcessIdentity(processId);
    if (descendant !== undefined) {
      targets.set(processId, descendant);
    }
  }
  targets.set(root.processId, root);
}

// Kills each target that is still the process first read; answers whether any was killed.
async function killStillSame(
  targets: ReadonlyMap<number, ProcessIdentity>,
  system: OrphanSweepSystem,
): Promise<boolean> {
  let isAnyKilled = false;
  for (const target of targets.values()) {
    const current = await system.readProcessIdentity(target.processId);
    if (current !== undefined && isSameProcess(target, current) && killIfPresent(target, system)) {
      isAnyKilled = true;
    }
  }
  return isAnyKilled;
}

function killIfPresent(target: ProcessIdentity, system: OrphanSweepSystem): boolean {
  try {
    system.killProcess(target.processId);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
