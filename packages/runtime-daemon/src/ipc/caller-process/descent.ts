// Whether the daemon itself started the process that opened a connection, read from the process's
// parents: a provider, a command an agent ran, a git hook or a setup command, or anything any of
// them started in turn, all descend from the daemon. The person's own clients do not: the desktop's
// main process starts or finds the daemon, and the command line runs from the person's terminal.
// The one exception is a terminal the daemon opened for the person, whose programs are theirs.

import type { PtyHost } from "../../pty/host/contract.js";
import type { CallerProcessReader } from "./contract.js";

/**
 * The check a connection's hello runs on this daemon: whether the process with the id descends
 * from it other than through `terminals`, read through `reader`. A process whose parents cannot
 * all be read, because one ended during the read, counts as the daemon's, since nothing then
 * vouches for it; the check rejects when the system refuses a read for any other reason.
 */
export function createStartedByDaemonCheck(
  reader: CallerProcessReader,
  terminals: Pick<PtyHost, "readTerminalProcessIds">,
): (callerProcessId: number) => Promise<boolean> {
  const daemonProcessId = process.pid;
  return async (callerProcessId) => {
    if (callerProcessId === daemonProcessId) {
      return false;
    }
    const visited = new Set<number>([callerProcessId]);
    let processId = callerProcessId;
    for (;;) {
      const parentProcessId = await reader.readParentProcessId(processId);
      if (parentProcessId === undefined) {
        return true;
      }
      if (parentProcessId === daemonProcessId) {
        return !terminals.readTerminalProcessIds().has(processId);
      }
      // The system's first process, or its kernel parent, ends every chain the daemon is not on.
      if (parentProcessId <= 1) {
        return false;
      }
      // An id handed to a new process mid-read can close a loop; such a reading vouches for
      // nothing.
      if (visited.has(parentProcessId)) {
        return true;
      }
      visited.add(parentProcessId);
      processId = parentProcessId;
    }
  };
}
