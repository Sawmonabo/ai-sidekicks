// One shell's output feed, keystrokes, pastes and size, for the pane showing it.
//
// `openOutput` is what the emulator calls once it is on screen: it follows the shell's output
// stream into the emulator through the output writer, which says when the pane is behind or caught
// up; the window is declared behind with `terminal.flowControl.update` while any pane in it
// watching the shell is behind, and a behind pane declares it again on each open of the stream, so
// a client helper started again hears it. It is stable for the shell, so the emulator is built once
// per shell. Each open of the stream names the subscription a write or a take is bound to; what
// is typed goes into the client helper's one queue for the shell through an input bound to it,
// and between a stream's end and its re-open the input binding holds it for the new subscription.
// Sizes go to `terminal.resize`, the newest only while one is out.

import { useCallback, useMemo } from "react";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { Unsubscribe } from "#shared/preload-api.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { openShellInput } from "#renderer/services/daemon/terminal/input.js";
import {
  followShellOutput,
  type ShellOutputSubject,
} from "#renderer/services/daemon/terminal/output.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { TerminalGridSize } from "../../emulator/xterm/adapter.js";
import { ShellInputBinding } from "../input-binding.js";
import { ShellOutputWriter, type ShellOutputSink } from "../output-writer.js";
import { ShellResizeQueue } from "../resize-queue.js";
import { windowShellFor } from "../window-shells.js";

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
  /** Why the stream could not be opened again, or why the last write, size or flow was refused. */
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

  const inputBinding = useMemo(
    () =>
      new ShellInputBinding((outputSubscriptionId) =>
        openShellInput(bridge, outputSubscriptionId, (refusal) => {
          // A write taken clears only a write's refusal; a size or flow refusal stands.
          publish((current) =>
            refusal !== undefined
              ? { ...current, refusal, refusedCall: "write" }
              : current.refusedCall === "write"
                ? { ...current, refusal: undefined, refusedCall: undefined }
                : current,
          );
        }),
      ),
    [bridge, publish],
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
          publish((current) => ({ ...current, refusal: reply.refusal, refusedCall: "resize" }));
        }
      }),
    [bridge, publish, sessionId, terminalId],
  );

  const openOutput = useCallback(
    (sink: ShellOutputSink): Unsubscribe => {
      const shell = { sessionId, terminalId };
      const declareFlow = (paused: boolean): void => {
        void callDaemon(bridge, "terminal.flowControl.update", { ...shell, paused }).then(
          (reply) => {
            if (reply.status === "refused") {
              publish((current) => ({
                ...current,
                refusal: reply.refusal,
                refusedCall: "flowControl",
              }));
            }
          },
        );
      };
      const writer = new ShellOutputWriter(sink, (isBehind) => {
        const paused = windowShellFor(bridge, shell).noteBehind(isBehind);
        if (paused !== undefined) {
          declareFlow(paused);
        }
      });
      const stopFollowing = followShellOutput(bridge, shell, (delivery) => {
        switch (delivery.kind) {
          case "opened":
            // The helper the stream now runs through may be a new one, which holds no pause.
            if (writer.isBehind) {
              declareFlow(true);
            }
            inputBinding.bind(delivery.subscriptionId);
            publish((current) => ({
              ...current,
              outputSubscriptionId: delivery.subscriptionId,
              isFollowing: true,
            }));
            return;
          case "ended":
            inputBinding.bind(undefined);
            publish((current) => ({ ...current, outputSubscriptionId: undefined }));
            return;
          case "frame":
            writer.apply(delivery.frame);
            return;
          case "reopenRefusal":
            publish((current) => ({
              ...current,
              refusal: delivery.refusal,
              refusedCall: "reopen",
            }));
            return;
        }
      });
      return () => {
        stopFollowing();
        writer.close();
        inputBinding.bind(undefined);
        publish((current) => ({
          ...current,
          outputSubscriptionId: undefined,
          isFollowing: false,
        }));
      };
    },
    [bridge, inputBinding, publish, sessionId, terminalId],
  );

  const typeKeys = useCallback(
    (data: string) => {
      inputBinding.type(data);
    },
    [inputBinding],
  );
  const pasteText = useCallback(
    (text: string) => {
      inputBinding.paste(text);
    },
    [inputBinding],
  );
  const resizeShell = useCallback(
    (size: TerminalGridSize) => {
      resizeQueue.resize(size);
    },
    [resizeQueue],
  );

  const { outputSubscriptionId, isFollowing, refusal } = value;
  return {
    outputSubscriptionId,
    isFollowing,
    refusal,
    openOutput,
    typeKeys,
    pasteText,
    resizeShell,
  };
}

/**
 * The held part of the feed: the subscription, whether it is followed, the refusal, and the call
 * it answered.
 */
interface ShellOutputState extends Pick<
  ShellOutput,
  "outputSubscriptionId" | "isFollowing" | "refusal"
> {
  readonly refusedCall: "write" | "resize" | "flowControl" | "reopen" | undefined;
}

const UNOPENED_SHELL_OUTPUT: ShellOutputState = {
  outputSubscriptionId: undefined,
  isFollowing: false,
  refusal: undefined,
  refusedCall: undefined,
};
