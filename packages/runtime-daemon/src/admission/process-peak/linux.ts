// Linux: `VmHWM` in `/proc/<pid>/status`, the peak of a process's resident memory.

import { readFile } from "node:fs/promises";

import { isMissingFileError } from "../../file/missing-error.js";
import type { ProcessPeakReader } from "./contract.js";

/** Reads a process's peak resident memory on Linux. */
export const LINUX_PROCESS_PEAK_READER: ProcessPeakReader = {
  readPeakBytes: async (processId) => {
    let status: string;
    try {
      status = await readFile(`/proc/${String(processId)}/status`, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
    const kibibytes = /^VmHWM:\s+(\d+) kB$/mu.exec(status)?.[1];
    if (kibibytes !== undefined) {
      return Number(kibibytes) * 1024;
    }
    // A process that has exited and is not yet reaped keeps its status but no memory lines.
    if (/^State:\s+Z/mu.test(status)) {
      return undefined;
    }
    throw new Error(`The status of process ${String(processId)} shows no VmHWM.`);
  },
};
