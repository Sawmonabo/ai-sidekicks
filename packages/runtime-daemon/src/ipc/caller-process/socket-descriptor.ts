// The file descriptor under a connected local socket, which the system calls that read its peer
// take. Node exposes none, so it is read off the socket's own handle.

import type * as net from "node:net";

/** The socket's file descriptor; throws when its handle holds none, as on a closed socket. */
export function readSocketDescriptor(socket: net.Socket): number {
  const handle = (socket as unknown as { readonly _handle?: { readonly fd?: unknown } })._handle;
  const descriptor = handle?.fd;
  if (typeof descriptor !== "number" || !Number.isInteger(descriptor) || descriptor < 0) {
    throw new Error("The local connection's socket has no file descriptor to read its caller from");
  }
  return descriptor;
}
