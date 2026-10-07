// `session.takeControl`: takes one shell's control lease for the calling device's connection.
//
// The caller is the device and connection the gateway stamped on the call, never a request field,
// so the lease ends with that connection, or with the pane output subscription the request names.
// The registry parses the request before the handler runs.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { TERMINAL_CONTROL_METHOD_DESCRIPTORS, type TerminalId } from "@ai-sidekicks/contracts/pty";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ShellControlLease } from "../../../pty/control-lease.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.takeControl`'s handler calls. */
export interface SessionTakeControlDeps {
  /** Finds a shell's lease in the session; throws for a terminal that is not that session's. */
  readonly findShellLease: (sessionId: SessionId, terminalId: TerminalId) => ShellControlLease;
}

/**
 * Binds `session.takeControl` onto the registry. A call with no stamped device or connection is
 * refused, because a lease must end with the connection that took it.
 */
export function registerSessionTakeControl(
  registry: MethodRegistry,
  deps: SessionTakeControlDeps,
): void {
  registerDescribedMethod(
    registry,
    TERMINAL_CONTROL_METHOD_DESCRIPTORS["session.takeControl"],
    async (request, ctx) => {
      if (ctx.deviceId === undefined || ctx.transportId === undefined) {
        throw new Error("session.takeControl needs the calling device and its connection");
      }
      return deps.findShellLease(request.sessionId, request.terminalId).take(
        {
          deviceId: ctx.deviceId,
          transportId: ctx.transportId,
          outputSubscriptionId: request.outputSubscriptionId,
        },
        request.force === true,
      );
    },
  );
}
