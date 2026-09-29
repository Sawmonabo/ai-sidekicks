// The output subscription belongs to the shell it was opened for.
//
// A rebind to a different bridge or terminal addresses a different shell, so the
// previous shell's stream is closed and never read as the replacement's. The call is a
// plain stub, and each case says which subscription is served and when.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { useTerminalOutputStream, type TerminalOutputStream } from "./useTerminalOutputStream.js";

function freshBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("terminal-output-stream") });
}

/** A subscription the case serves by hand, so the case chooses when it lands. */
function heldSubscription(): {
  readonly subscribeOutput: (request: {
    readonly terminalId: string;
  }) => Promise<TerminalOutputStream>;
  readonly requestedTerminalIds: string[];
  readonly serve: (callIndex: number) => TerminalOutputStream;
} {
  const requestedTerminalIds: string[] = [];
  const serveByCall: ((stream: TerminalOutputStream) => void)[] = [];
  return {
    requestedTerminalIds,
    subscribeOutput: (request) => {
      requestedTerminalIds.push(request.terminalId);
      return new Promise<TerminalOutputStream>((resolve) => {
        serveByCall.push(resolve);
      });
    },
    serve: (callIndex) => {
      const stream = { close: vi.fn() };
      const resolve = serveByCall[callIndex];
      if (resolve === undefined) {
        throw new Error(`no subscription number ${String(callIndex)} is out`);
      }
      resolve(stream);
      return stream;
    },
  };
}

/** Serve one held subscription and let React commit what that published. */
async function serveAndSettle(
  held: ReturnType<typeof heldSubscription>,
  callIndex: number,
): Promise<TerminalOutputStream> {
  const stream = held.serve(callIndex);
  await act(async () => {
    await Promise.resolve();
  });
  return stream;
}

interface StreamProps {
  readonly bridge: ConsoleBridge;
  readonly terminalId: string;
}

describe("terminal output stream — the handle belongs to the shell it was opened for", () => {
  it("subscribes once per terminal and holds the stream the daemon served", async () => {
    const held = heldSubscription();
    const bridge = freshBridge();
    const { result } = renderHook(
      (props: StreamProps) =>
        useTerminalOutputStream(props.bridge, props.terminalId, held.subscribeOutput),
      { initialProps: { bridge, terminalId: "session-one" } },
    );
    expect(result.current).toBeUndefined();

    const served = await serveAndSettle(held, 0);

    expect(held.requestedTerminalIds).toStrictEqual(["session-one"]);
    expect(result.current).toBe(served);
  });

  it("closes the stream and subscribes again when bound to a different shell", async () => {
    const held = heldSubscription();
    const bridge = freshBridge();
    const { result, rerender } = renderHook(
      (props: StreamProps) =>
        useTerminalOutputStream(props.bridge, props.terminalId, held.subscribeOutput),
      { initialProps: { bridge, terminalId: "session-one" } },
    );
    const first = await serveAndSettle(held, 0);

    rerender({ bridge, terminalId: "session-another-shell" });

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(result.current).toBeUndefined();
    expect(held.requestedTerminalIds).toStrictEqual(["session-one", "session-another-shell"]);
  });

  it("closes a stream that is served after its terminal was left, and never reads it", async () => {
    const held = heldSubscription();
    const bridge = freshBridge();
    const { result, rerender } = renderHook(
      (props: StreamProps) =>
        useTerminalOutputStream(props.bridge, props.terminalId, held.subscribeOutput),
      { initialProps: { bridge, terminalId: "session-one" } },
    );
    rerender({ bridge, terminalId: "session-another-shell" });

    const late = await serveAndSettle(held, 0);

    expect(late.close).toHaveBeenCalledTimes(1);
    expect(result.current).toBeUndefined();
  });

  it("closes the stream when the pane unmounts", async () => {
    const held = heldSubscription();
    const bridge = freshBridge();
    const { unmount } = renderHook(() =>
      useTerminalOutputStream(bridge, "session-one", held.subscribeOutput),
    );
    const served = await serveAndSettle(held, 0);

    unmount();

    expect(served.close).toHaveBeenCalledTimes(1);
  });
});
