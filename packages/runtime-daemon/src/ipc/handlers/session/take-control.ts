// `session.takeControl`: takes one shell's control lease for the calling device's connection.
//
// The caller is the device and connection the gateway stamped on the call, never a request field,
// so the binding the take adds ends with that connection or with the pane output subscription the
// request names, and the hold with its last binding. The subscription is checked to be the calling
// connection's own open one to that shell before the lease reads it.
// The registry parses the request before the handler runs.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { TERMINAL_CONTROL_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/pty";

import type { TerminalSessions } from "../../../pty/terminal-sessions.js";
import { shellConnectionOf } from "../pty/caller.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.takeControl`'s handler calls. */
export interface SessionTakeControlDeps {
  readonly terminalSessions: Pick<TerminalSessions, "leaseForOutputSubscription">;
}

/**
 * Binds `session.takeControl` onto the registry. A shell the session does not have is refused
 * `pty.not_found`, and a subscription that is not the caller's own open one to that shell
 * `pty.output_subscription_not_found`. A call with no stamped device or connection is refused,
 * because a lease must end with the connection that took it.
 */
export function registerSessionTakeControl(
  registry: MethodRegistry,
  deps: SessionTakeControlDeps,
): void {
  registerDescribedMethod(
    registry,
    TERMINAL_CONTROL_METHOD_DESCRIPTORS["session.takeControl"],
    async (request, ctx) => {
      const caller = {
        ...shellConnectionOf(ctx, "session.takeControl"),
        outputSubscriptionId: request.outputSubscriptionId,
      };
      return deps.terminalSessions
        .leaseForOutputSubscription(request.sessionId, request.terminalId, caller)
        .take(caller, request.force === true);
    },
  );
}
