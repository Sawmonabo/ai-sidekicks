// `session.setTerminalFlowControl`: records whether the calling connection has fallen behind on one
// shell's output. The connection is the one the gateway stamped on the call, so its state clears
// when it disconnects. A call naming a shell the session does not have changes nothing and is
// answered as any other, since it may race a closing shell. The registry parses the request
// before the handler runs.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { TERMINAL_CONTROL_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/pty";

import type { ShellTable } from "../../../pty/shell/table.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.setTerminalFlowControl`'s handler calls. */
export interface SessionSetTerminalFlowControlDeps {
  readonly shellTable: Pick<ShellTable, "declareFlowControl">;
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
      await deps.shellTable.declareFlowControl(request, ctx.transportId);
      return { accepted: true as const };
    },
  );
}
