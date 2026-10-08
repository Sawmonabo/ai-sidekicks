// A session's set of shells: `pty.list`, the live list, and `pty.open`, `pty.close` and
// `pty.reorder`. `pty.list` answers only the `subscriptionId`; the first `$/subscription/notify`
// value is the whole list, and each later one the whole list again after a change, through the
// subscription ack barrier, which holds a value until the `{subscriptionId}` response is written.
// The registry parses each request before its handler runs.

import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { SubscribeAckResponse } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  PTY_METHOD_DESCRIPTORS,
  type PtyListRequest,
  type PtyListUpdate,
} from "@ai-sidekicks/contracts/pty";

import type { TerminalSessions } from "../../../pty/terminal-sessions.js";
import type { StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import { registerDescribedMethod } from "../register-described-method.js";
import { shellConnectionOf } from "./caller.js";

/** What the shell-set verbs call. */
export interface PtyShellMethodsDeps {
  readonly terminalSessions: Pick<TerminalSessions, "followList" | "open" | "close" | "reorder">;
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
}

/**
 * Binds `pty.list`, `pty.open`, `pty.close` and `pty.reorder` onto the registry. A second binding
 * on one registry throws. `pty.list` for a session the daemon does not hold is refused
 * `session.not_found`, and one with no transport identity is a daemon wiring fault, thrown as a
 * plain `Error`.
 */
export function registerPtyShellMethods(registry: MethodRegistry, deps: PtyShellMethodsDeps): void {
  const listDescriptor = PTY_METHOD_DESCRIPTORS["pty.list"];
  const followList: Handler<PtyListRequest, SubscribeAckResponse> = async (params, ctx) => {
    if (ctx.transportId === undefined) {
      throw new Error("pty.list: a subscription needs the connection's transport id");
    }
    const subscription = deps.streamingPrimitive.createSubscription<PtyListUpdate>(
      ctx.transportId,
      listDescriptor.emissionSchema,
    );
    const barrier = createSubscriptionAckBarrier(subscription, listDescriptor.method);
    try {
      const unfollow = deps.terminalSessions.followList(params.sessionId, (update) => {
        barrier.emit(update);
      });
      subscription.onCancel(unfollow);
    } catch (error) {
      // The client never received this id, so the subscription goes without an end frame.
      deps.streamingPrimitive.cancelSubscription(subscription.subscriptionId);
      throw error;
    }
    barrier.release();
    return { subscriptionId: subscription.subscriptionId };
  };
  registry.register(
    listDescriptor.method,
    listDescriptor.requestSchema,
    listDescriptor.responseSchema,
    followList,
    { mutating: listDescriptor.mutating },
  );

  registerDescribedMethod(registry, PTY_METHOD_DESCRIPTORS["pty.open"], (request) =>
    deps.terminalSessions.open(request),
  );
  registerDescribedMethod(registry, PTY_METHOD_DESCRIPTORS["pty.close"], async (request, ctx) => {
    await deps.terminalSessions.close(request, shellConnectionOf(ctx, "pty.close").deviceId);
    return null;
  });
  registerDescribedMethod(registry, PTY_METHOD_DESCRIPTORS["pty.reorder"], async (request) => {
    deps.terminalSessions.reorder(request);
    return null;
  });
}
