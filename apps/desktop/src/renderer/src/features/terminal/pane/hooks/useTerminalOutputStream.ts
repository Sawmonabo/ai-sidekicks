// Subscribes the terminal pane to one terminal's output stream.
//
// The handle belongs to its `(bridge, terminalId)` subject, so a pane rebound to another
// terminal reads no handle until that terminal's own subscription is served, and the one for
// the terminal it left is closed.

import { useEffect } from "react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";

/** An output stream the daemon served; closing it releases the subscription. */
export interface TerminalOutputStream {
  readonly close: () => void;
}

/** Asks the daemon to stream one terminal's output. */
export type SubscribeTerminalOutput = (request: {
  readonly terminalId: string;
}) => Promise<TerminalOutputStream>;

/**
 * Subscribe to one terminal's output and hold the served stream, per terminal.
 *
 * The stream is closed when the terminal changes or the pane unmounts, including one
 * that is served after either. A rejected subscription is not caught.
 */
export function useTerminalOutputStream(
  bridge: PlatformBridge,
  terminalId: string,
  subscribeOutput: SubscribeTerminalOutput,
): TerminalOutputStream | undefined {
  const { value: stream, publish } = useSubjectScopedState<TerminalOutputStream | undefined>(
    bridge,
    terminalId,
    () => undefined,
  );

  useEffect(() => {
    let isSuperseded = false;
    let served: TerminalOutputStream | undefined;
    void subscribeOutput({ terminalId }).then((opened) => {
      if (isSuperseded) {
        opened.close();
        return;
      }
      served = opened;
      publish(opened);
    });
    return () => {
      isSuperseded = true;
      served?.close();
    };
  }, [terminalId, publish, subscribeOutput]);

  return stream;
}
