// How macOS and Linux end a child's tree: the child leads its own process group, and the group
// gets the signal.

import type { ProcessTreeEnding } from "./contract.js";

/** A process group signaled whole, `-pid`; a group already gone answers `ESRCH`. */
export const POSIX_PROCESS_TREE_ENDING: ProcessTreeEnding = {
  startsOwnGroup: true,
  // Async, so a failed signal rejects rather than throwing at the call.
  endProcessTree: async (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  },
};
