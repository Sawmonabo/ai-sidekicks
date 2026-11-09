// One shell's output feed and keystrokes, for the pane showing it.
//
// `openOutput` is what the emulator calls once it is on screen: it follows the shell's output
// stream into the emulator through the output writer, which declares the pane behind or caught up
// with `terminal.flowControl.update`, and it is stable for the shell, so the emulator is built
// once per shell. Each open of the stream names the subscription a write or a take is bound to.
// Keystrokes go to `terminal.write` in typed order, bound to that subscription.

import { useCallback, useMemo } from "react";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { Unsubscribe } from "#shared/preload-api.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import {
  followShellOutput,
  type ShellOutputSubject,
} from "#renderer/services/daemon/terminal/output.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { ShellInputQueue } from "../input-queue.js";
import { ShellOutputWriter, type ShellOutputSink } from "../output-writer.js";

/** A shell's feed as the pane holds it. */
export interface ShellOutput {
  /** Feed the shell's output into an emulator now on screen; the handle stops it. */
  readonly openOutput: (sink: ShellOutputSink) => Unsubscribe;
  /** The open output subscription, which writes and takes are bound to; `undefined` until open. */
  readonly outputSubscriptionId: SubscriptionId | undefined;
  /** Why the stream could not be opened again, or the last write or flow update was refused. */
  readonly refusal: Refusal | undefined;
  /** Send typed keys to the shell, in order. */
  readonly typeKeys: (data: string) => void;
}

/** Follow one shell's output and take its keystrokes while the pane shows it. */
export function useShellOutput(bridge: PlatformBridge, subject: ShellOutputSubject): ShellOutput {
  const { sessionId, terminalId } = subject;
  const { value, publish } = useSubjectScopedState<ShellOutputState>(
    bridge,
    `${sessionId} ${terminalId}`,
    () => UNOPENED_SHELL_OUTPUT,
  );
  const subscriptionIdRef = useLatestRef(value.outputSubscriptionId);

  const openOutput = useCallback(
    (sink: ShellOutputSink): Unsubscribe => {
      const shell = { sessionId, terminalId };
      const writer = new ShellOutputWriter(sink, (isBehind) => {
        void callDaemon(bridge, "terminal.flowControl.update", {
          ...shell,
          paused: isBehind,
        }).then((reply) => {
          if (reply.status === "refused") {
            publish((current) => ({ ...current, refusal: reply.refusal }));
          }
        });
      });
      const stopFollowing = followShellOutput(bridge, shell, (delivery) => {
        switch (delivery.kind) {
          case "opened":
            publish((current) => ({ ...current, outputSubscriptionId: delivery.subscriptionId }));
            return;
          case "frame":
            writer.apply(delivery.frame);
            return;
          case "reopenRefusal":
            publish((current) => ({ ...current, refusal: delivery.refusal }));
            return;
        }
      });
      return () => {
        stopFollowing();
        writer.close();
        publish((current) => ({ ...current, outputSubscriptionId: undefined }));
      };
    },
    [bridge, publish, sessionId, terminalId],
  );

  const inputQueue = useMemo(
    () =>
      new ShellInputQueue(async (data) => {
        const outputSubscriptionId = subscriptionIdRef.current;
        if (outputSubscriptionId === undefined) {
          // The write gate shuts without a subscription, so only keys typed as it shut land here.
          return;
        }
        const reply = await callDaemon(bridge, "terminal.write", {
          kind: "keys",
          sessionId,
          terminalId,
          outputSubscriptionId,
          data,
        });
        publish((current) => ({
          ...current,
          refusal: reply.status === "refused" ? reply.refusal : undefined,
        }));
      }),
    [bridge, publish, sessionId, subscriptionIdRef, terminalId],
  );
  const typeKeys = useCallback(
    (data: string) => {
      inputQueue.type(data);
    },
    [inputQueue],
  );

  return { ...value, openOutput, typeKeys };
}

/** The held part of the feed: the subscription and the refusal. */
type ShellOutputState = Pick<ShellOutput, "outputSubscriptionId" | "refusal">;

const UNOPENED_SHELL_OUTPUT: ShellOutputState = {
  outputSubscriptionId: undefined,
  refusal: undefined,
};
