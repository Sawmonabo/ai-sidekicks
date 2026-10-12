// What the daemon reads of the process at the other end of a local connection: its id, and the
// parent of any process, so the daemon can tell whether it or a provider service it reaches started
// that process. Node offers neither, so each system's module answers them through its own calls.

import type * as net from "node:net";

/** Reads which process is at the other end of a local connection, and a process's parent. */
export interface CallerProcessReader {
  /**
   * The id of the process at the other end of the connected local `socket`: on Linux the one that
   * connected (or listened, on a socket the daemon dialed), as recorded at the connect; on macOS
   * the one that last used that end, which is the connecting one until it hands the socket on.
   * `undefined` when that end has already closed; throws when the system cannot say otherwise.
   */
  readPeerProcessId(socket: net.Socket): number | undefined;
  /**
   * The id of the parent of process `processId`, `undefined` when no process has the id. Rejects
   * on any other refusal.
   */
  readParentProcessId(processId: number): Promise<number | undefined>;
}
