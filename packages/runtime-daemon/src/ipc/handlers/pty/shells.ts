// A session's set of shells: `pty.list`, the live list, and `pty.open`, `pty.close` and
// `pty.reorder`. `pty.list` answers only the `subscriptionId`; the first `$/subscription/notify`
// value is the whole list, and each later one the whole list again after a change. Each list is
// whole and replaces the one before, so one that finds the connection's outbound queue full waits,
// only the newest kept, and goes out once the queue drains. The registry parses each request
// before its handler runs.

import { PTY_METHOD_DESCRIPTORS, type PtyListUpdate } from "@ai-sidekicks/contracts/pty";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";

import type { ShellTable } from "../../../pty/shell/table.js";
import { openLatestValueStream, type LatestValueStreamDeps } from "../../latest-value-stream.js";
import {
  registerDescribedMethod,
  registerDescribedSubscription,
} from "../register-described-method.js";
import { shellConnectionOf } from "./caller.js";

/** What the shell-set verbs call. */
interface PtyShellMethodsDeps extends LatestValueStreamDeps {
  readonly shellTable: Pick<ShellTable, "followList" | "open" | "close" | "reorder">;
}

/**
 * Binds `pty.list`, `pty.open`, `pty.close` and `pty.reorder` onto the registry. A second binding
 * on one registry throws. `pty.list` for a session the daemon does not hold is refused
 * `session.not_found` with nothing left open, and one with no transport identity is a daemon
 * wiring fault, thrown as a plain `Error`.
 */
export function registerPtyShellMethods(registry: MethodRegistry, deps: PtyShellMethodsDeps): void {
  const list = PTY_METHOD_DESCRIPTORS["pty.list"];
  registerDescribedSubscription(registry, list, (request, context) =>
    openLatestValueStream<PtyListUpdate>(deps, {
      method: list.method,
      emissionSchema: list.emissionSchema,
      transportId: context.transportId,
      follow: (outlet) =>
        deps.shellTable.followList(request.sessionId, (update) => {
          outlet.send(update);
        }),
    }),
  );

  registerDescribedMethod(registry, PTY_METHOD_DESCRIPTORS["pty.open"], (request) =>
    deps.shellTable.open(request),
  );
  registerDescribedMethod(registry, PTY_METHOD_DESCRIPTORS["pty.close"], async (request, ctx) => {
    await deps.shellTable.close(request, shellConnectionOf(ctx, "pty.close").deviceId);
    return null;
  });
  registerDescribedMethod(registry, PTY_METHOD_DESCRIPTORS["pty.reorder"], async (request) => {
    deps.shellTable.reorder(request);
    return null;
  });
}
