// `session.setTerminalFlowControl`: records whether the calling connection has fallen behind on one
// shell's output. The connection is the one the gateway stamped on the call, so its state clears
// when it disconnects. The registry parses the request before the handler runs.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { TERMINAL_CONTROL_METHOD_DESCRIPTORS, type TerminalId } from "@ai-sidekicks/contracts/pty";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ShellFlowControl } from "../../../pty/flow-control.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.setTerminalFlowControl`'s handler calls. */
export interface SessionSetTerminalFlowControlDeps {
  /** Finds a shell's flow control in the session; throws for a terminal the session lacks. */
  readonly findShellFlowControl: (sessionId: SessionId, terminalId: TerminalId) => ShellFlowControl;
}

/**
 * Binds `session.setTerminalFlowControl` onto the registry. A call with no stamped connection is
 * refused, because a connection's state must clear when it ends.
 */
export function registerSessionSetTerminalFlowControl(
  registry: MethodRegistry,
  deps: SessionSetTerminalFlowControlDeps,
): void {
  registerDescribedMethod(
    registry,
    TERMINAL_CONTROL_METHOD_DESCRIPTORS["session.setTerminalFlowControl"],
    async (request, ctx) => {
      if (ctx.transportId === undefined) {
        throw new Error("session.setTerminalFlowControl needs the calling connection");
      }
      await deps
        .findShellFlowControl(request.sessionId, request.terminalId)
        .declare(ctx.transportId, request.paused);
      return { accepted: true as const };
    },
  );
}
