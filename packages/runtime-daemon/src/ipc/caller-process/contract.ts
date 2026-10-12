// What the daemon reads of the process at the other end of a local connection: its id, and the
// parent of any process, so the daemon can tell whether it started that process itself. Node
// offers neither, so each system's module answers them through its own calls.

import type * as net from "node:net";

/** Reads which process opened a local connection, and a process's parent. */
export interface CallerProcessReader {
  /**
   * The id of the process that opened the connection `socket` accepted, as the system recorded it
   * at the connect. Throws when the system cannot say.
   */
  readConnectedProcessId(socket: net.Socket): number;
  /**
   * The id of the parent of process `processId`, `undefined` when no process has the id. Rejects
   * on any other refusal.
   */
  readParentProcessId(processId: number): Promise<number | undefined>;
}

/**
 * The file descriptor under an accepted local socket. Node exposes none, so it is read off the
 * socket's own handle; throws when the handle holds none, as on a closed socket.
 */
export function readSocketDescriptor(socket: net.Socket): number {
  const handle = (socket as unknown as { readonly _handle?: { readonly fd?: unknown } })._handle;
  const descriptor = handle?.fd;
  if (typeof descriptor !== "number" || !Number.isInteger(descriptor) || descriptor < 0) {
    throw new Error("The local connection's socket has no file descriptor to read its caller from");
  }
  return descriptor;
}
