// One shell's output stream and what a pane sends it: `pty.outputSubscribe`, `pty.write` and
// `pty.resize`. `pty.outputSubscribe` answers only the `subscriptionId`; its frames follow as
// `$/subscription/notify` values through the subscription ack barrier, which holds each until the
// `{subscriptionId}` response is written. Its end, by the client's cancel or its connection
// closing, ends what the subscription carried. The registry parses each request before its
// handler runs.

import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { SubscribeAckResponse } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  PTY_METHOD_DESCRIPTORS,
  type PtyOutputFrame,
  type PtyOutputSubscribeRequest,
} from "@ai-sidekicks/contracts/pty";

import type { ShellTable } from "../../../pty/shell/table.js";
import type { StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import { registerDescribedMethod } from "../register-described-method.js";
import { shellConnectionOf } from "./caller.js";

/** What a shell's stream verbs call. */
interface PtyInputOutputMethodsDeps {
  readonly shellTable: Pick<
    ShellTable,
    "subscribeOutput" | "endOutputSubscription" | "write" | "resize"
  >;
  /** The streaming primitive every streaming handler shares, so disconnect cleanup is one map. */
  readonly streamingPrimitive: StreamingPrimitive;
}

/**
 * Binds `pty.outputSubscribe`, `pty.write` and `pty.resize` onto the registry. A second binding on
 * one registry throws. A call with no stamped device or connection is a daemon wiring fault,
 * thrown as a plain `Error`.
 */
export function registerPtyInputOutputMethods(
  registry: MethodRegistry,
  deps: PtyInputOutputMethodsDeps,
): void {
  const subscribeDescriptor = PTY_METHOD_DESCRIPTORS["pty.outputSubscribe"];
  const subscribeOutput: Handler<PtyOutputSubscribeRequest, SubscribeAckResponse> = async (
    params,
    ctx,
  ) => {
    const { transportId } = shellConnectionOf(ctx, subscribeDescriptor.method);
    const subscription = deps.streamingPrimitive.createSubscription<PtyOutputFrame>(
      transportId,
      subscribeDescriptor.emissionSchema,
    );
    const barrier = createSubscriptionAckBarrier(subscription, subscribeDescriptor.method);
    subscription.onCancel(() => {
      deps.shellTable.endOutputSubscription(subscription.subscriptionId);
    });
    try {
      await deps.shellTable.subscribeOutput(params, {
        subscriptionId: subscription.subscriptionId,
        transportId,
        send: (frame) => {
          barrier.emit(frame);
        },
        complete: () => {
          barrier.deferUntilAck(() => {
            subscription.complete();
          });
        },
      });
    } catch (error) {
      // The client never received this id, so the subscription goes without an end frame.
      deps.streamingPrimitive.cancelSubscription(subscription.subscriptionId);
      throw error;
    }
    barrier.release();
    return { subscriptionId: subscription.subscriptionId };
  };
  registry.register(
    subscribeDescriptor.method,
    subscribeDescriptor.requestSchema,
    subscribeDescriptor.responseSchema,
    subscribeOutput,
    { mutating: subscribeDescriptor.mutating },
  );

  registerDescribedMethod(registry, PTY_METHOD_DESCRIPTORS["pty.write"], async (request, ctx) => {
    await deps.shellTable.write(request, {
      ...shellConnectionOf(ctx, "pty.write"),
      outputSubscriptionId: request.outputSubscriptionId,
    });
    return null;
  });
  registerDescribedMethod(registry, PTY_METHOD_DESCRIPTORS["pty.resize"], async (request, ctx) => {
    await deps.shellTable.resize(request, shellConnectionOf(ctx, "pty.resize"));
    return null;
  });
}
