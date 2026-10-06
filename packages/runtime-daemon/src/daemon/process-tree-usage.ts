// How much processor and memory the daemon and every process under it use, read when asked: the
// daemon's own process, its terminals, its providers and whatever they started.

import * as os from "node:os";

import pidtree from "pidtree";
import pidusage from "pidusage";

/** One reading over a process and every process under it. */
export interface ProcessTreeUsage {
  /** A share of the whole machine's processor, from 0 to 100. */
  readonly processorPercent: number;
  readonly residentBytes: number;
}

/**
 * Reads `rootPid` and every process under it. A process's processor share is measured since this
 * module last read it, or since the process started at its first reading.
 */
export async function readProcessTreeUsage(rootPid: number): Promise<ProcessTreeUsage> {
  const pids = await pidtree(rootPid, { root: true });
  // On Linux a process that ended between the two reads has a null or missing reading, though the
  // library's types say otherwise; on macOS it is left out. Either way it counts for nothing.
  const readings: Record<string, pidusage.Status | null | undefined> = await pidusage(pids);
  let corePercent = 0;
  let residentBytes = 0;
  for (const reading of Object.values(readings)) {
    if (reading === null || reading === undefined) {
      continue;
    }
    corePercent += reading.cpu;
    residentBytes += reading.memory;
  }
  // Each reading is a share of one core, so the sum is divided over every core the machine has.
  return {
    processorPercent: Math.min(100, corePercent / os.availableParallelism()),
    residentBytes,
  };
}
