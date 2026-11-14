// One shell's output feed, keystrokes, pastes and size, for the pane showing it.
//
// `openOutput` is what the emulator calls once it is on screen: it follows the shell's output
// stream into the emulator through the output writer, which says when the pane is behind or caught
// up; the window is declared behind with `terminal.flowControl.update` while any pane in it
// watching the shell is behind, and a behind pane declares it again on each open of the stream, so
// a client helper started again hears it. It is stable for the shell, so the emulator is built once
// per shell. Each open of the stream names the subscription a write or a take is bound to; what
// is typed goes through the window's one input binding for the shell (`window-shells.ts`), which
// holds it from a stream's end until its re-open, and until the ended one's input has handed back
// all it held, behind what came back unsent. A pane closed meanwhile lets its stream go, and the
// binding sends what waits once it may, or on this pane's next open if that comes first. A re-open
// refused because the shell or its session is gone lets the held input go, drawn once as the
// refusal of a write to that shell. The first frame ends the pane's loading line. Sizes go to
// `terminal.resize`, the newest only while one is out.

import { useCallback, useMemo, useRef } from "react";

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
import { isShellGone, type ShellInputBinding } from "../input-binding.js";
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
  /** Whether the feed's first frame, the shell's output and who holds it, has arrived. */
  readonly hasOutput: boolean;
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
  // The window's binding for the shell, from the pane's open of its output to its close: what is
  // typed reaches the shell only while the feed is followed.
  const inputBindingRef = useRef<ShellInputBinding | undefined>(undefined);

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
      const windowShell = windowShellFor(bridge, shell);
      const inputBinding = windowShell.inputBinding;
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
        const paused = windowShell.noteBehind(isBehind);
        if (paused !== undefined) {
          declareFlow(paused);
        }
      });
      inputBinding.follow((refusal) => {
        // A write taken clears only a write's refusal; a size or flow refusal stands.
        publish((current) =>
          refusal !== undefined
            ? { ...current, refusal, refusedCall: "write" }
            : current.refusedCall === "write"
              ? { ...current, refusal: undefined, refusedCall: undefined }
              : current,
        );
      });
      inputBindingRef.current = inputBinding;
      let hasFrame = false;
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
            if (!hasFrame) {
              hasFrame = true;
              publish((current) => ({ ...current, hasOutput: true }));
            }
            return;
          case "reopenRefusal": {
            // A gone shell takes nothing held for it, refused as a write to it is, once.
            const hadHeldInput = isShellGone(delivery.refusal) && inputBinding.dropHeld();
            publish((current) => ({
              ...current,
              refusal: delivery.refusal,
              refusedCall: hadHeldInput ? "write" : "reopen",
            }));
            return;
          }
        }
      });
      return () => {
        inputBindingRef.current = undefined;
        writer.close();
        inputBinding.close(stopFollowing);
        publish((current) => ({
          ...current,
          outputSubscriptionId: undefined,
          isFollowing: false,
        }));
      };
    },
    [bridge, publish, sessionId, terminalId],
  );

  const typeKeys = useCallback((data: string) => {
    inputBindingRef.current?.type(data);
  }, []);
  const pasteText = useCallback((text: string) => {
    inputBindingRef.current?.paste(text);
  }, []);
  const resizeShell = useCallback(
    (size: TerminalGridSize) => {
      resizeQueue.resize(size);
    },
    [resizeQueue],
  );

  const { outputSubscriptionId, isFollowing, hasOutput, refusal } = value;
  return {
    outputSubscriptionId,
    isFollowing,
    hasOutput,
    refusal,
    openOutput,
    typeKeys,
    pasteText,
    resizeShell,
  };
}

/**
 * The held part of the feed: the subscription, whether it is followed and has drawn, the refusal,
 * and the call it answered.
 */
interface ShellOutputState extends Pick<
  ShellOutput,
  "outputSubscriptionId" | "isFollowing" | "hasOutput" | "refusal"
> {
  readonly refusedCall: "write" | "resize" | "flowControl" | "reopen" | undefined;
}

const UNOPENED_SHELL_OUTPUT: ShellOutputState = {
  outputSubscriptionId: undefined,
  isFollowing: false,
  hasOutput: false,
  refusal: undefined,
  refusedCall: undefined,
};
