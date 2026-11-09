// One shell's output feed, keystrokes, pastes and size, for the pane showing it.
//
// `openOutput` is what the emulator calls once it is on screen: it follows the shell's output
// stream into the emulator through the output writer, which declares the pane behind or caught up
// with `terminal.flowControl.update`, and it is stable for the shell, so the emulator is built
// once per shell. Each open of the stream names the subscription a write or a take is bound to;
// between a stream's end and its re-open the input queue holds what is typed and sends it bound to
// the new subscription. Sizes go to `terminal.resize`, the newest only while one is out.

import { useCallback, useMemo } from "react";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { Unsubscribe } from "#shared/preload-api.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import {
  followShellOutput,
  type ShellOutputSubject,
} from "#renderer/services/daemon/terminal/output.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { TerminalGridSize } from "../../emulator/xterm/adapter.js";
import { ShellInputQueue } from "../input-queue.js";
import { ShellOutputWriter, type ShellOutputSink } from "../output-writer.js";
import { ShellResizeQueue } from "../resize-queue.js";

/** A shell's feed as the pane holds it. */
export interface ShellOutput {
  /** Feed the shell's output into an emulator now on screen; the handle stops it. */
  readonly openOutput: (sink: ShellOutputSink) => Unsubscribe;
  /** The open output subscription, which writes and takes are bound to; `undefined` until open. */
  readonly outputSubscriptionId: SubscriptionId | undefined;
  /**
   * Whether the feed is followed, from its first open until the pane closes it, across the gaps
   * while it is opened again; what is typed meanwhile waits for the new subscription.
   */
  readonly isFollowing: boolean;
  /** Why the stream could not be opened again, or the last write, size or flow update was refused. */
  readonly refusal: Refusal | undefined;
  /** Send typed keys to the shell, in order. */
  readonly typeKeys: (data: string) => void;
  /** Send pasted text to the shell as one paste, in order with the keys around it. */
  readonly pasteText: (text: string) => void;
  /** Tell the shell its grid's size; call it only while this device holds the shell. */
  readonly resizeShell: (size: TerminalGridSize) => void;
}

/** Follow one shell's output and take its keystrokes, pastes and size while the pane shows it. */
export function useShellOutput(bridge: PlatformBridge, subject: ShellOutputSubject): ShellOutput {
  const { sessionId, terminalId } = subject;
  const { value, publish } = useSubjectScopedState<ShellOutputState>(
    bridge,
    `${sessionId} ${terminalId}`,
    () => UNOPENED_SHELL_OUTPUT,
  );

  const inputQueue = useMemo(
    () =>
      new ShellInputQueue(async (write, outputSubscriptionId) => {
        const reply = await callDaemon(bridge, "terminal.write", {
          ...write,
          sessionId,
          terminalId,
          outputSubscriptionId,
        });
        publish((current) => ({
          ...current,
          refusal: reply.status === "refused" ? reply.refusal : undefined,
        }));
      }),
    [bridge, publish, sessionId, terminalId],
  );

  const resizeQueue = useMemo(
    () =>
      new ShellResizeQueue(async (size) => {
        const reply = await callDaemon(bridge, "terminal.resize", {
          sessionId,
          terminalId,
          ...size,
        });
        if (reply.status === "refused") {
          publish((current) => ({ ...current, refusal: reply.refusal }));
        }
      }),
    [bridge, publish, sessionId, terminalId],
  );

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
            inputQueue.bind(delivery.subscriptionId);
            publish((current) => ({
              ...current,
              outputSubscriptionId: delivery.subscriptionId,
              isFollowing: true,
            }));
            return;
          case "ended":
            inputQueue.bind(undefined);
            publish((current) => ({ ...current, outputSubscriptionId: undefined }));
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
        inputQueue.bind(undefined);
        publish((current) => ({
          ...current,
          outputSubscriptionId: undefined,
          isFollowing: false,
        }));
      };
    },
    [bridge, inputQueue, publish, sessionId, terminalId],
  );

  const typeKeys = useCallback(
    (data: string) => {
      inputQueue.type(data);
    },
    [inputQueue],
  );
  const pasteText = useCallback(
    (text: string) => {
      inputQueue.paste(text);
    },
    [inputQueue],
  );
  const resizeShell = useCallback(
    (size: TerminalGridSize) => {
      resizeQueue.resize(size);
    },
    [resizeQueue],
  );

  return { ...value, openOutput, typeKeys, pasteText, resizeShell };
}

/** The held part of the feed: the subscription, whether it is followed, and the refusal. */
type ShellOutputState = Pick<ShellOutput, "outputSubscriptionId" | "isFollowing" | "refusal">;

const UNOPENED_SHELL_OUTPUT: ShellOutputState = {
  outputSubscriptionId: undefined,
  isFollowing: false,
  refusal: undefined,
};
