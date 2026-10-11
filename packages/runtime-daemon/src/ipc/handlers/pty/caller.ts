// The calling device and connection of a shell act, as the gateway stamped them on the call, never
// a request field, so every binding a shell's hold takes ends with the connection that made it.

import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc/registry";

import type { ShellConnection } from "../../../pty/control-lease.js";

/**
 * The device and connection that made a shell act. Throws a plain `Error`, an internal error on
 * the wire, for a call with none stamped: every shell act belongs to a connection, so that is a
 * daemon wiring fault.
 */
export function shellConnectionOf(context: HandlerContext, method: string): ShellConnection {
  if (context.deviceId === undefined || context.transportId === undefined) {
    throw new Error(`${method} needs the calling device and its connection`);
  }
  return { deviceId: context.deviceId, transportId: context.transportId };
}
