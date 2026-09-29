// The viewer-identity hook, driven with a plain read function.
//
// The identity belongs to the inputs that produced it: a pane handed a different session
// reverts to `not-loaded` on the first frame that sees it, and a read that lands after
// its inputs were left settles nothing. The read is held by hand so each case chooses
// when it answers.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { unscriptedScenario } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import { createFixtureBridge } from "@renderer/console/bridge/fixture/call-plane/bridge.js";
import { type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import {
  useTerminalViewerIdentity,
  type ReadTerminalViewerUser,
} from "../../lease/hooks/useTerminalDeviceIdentity.js";

function freshBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("terminal-viewer-identity") });
}

/** A read the case answers by hand, keyed by the order the reads were made in. */
function heldRead(): {
  readonly readViewerUser: ReadTerminalViewerUser;
  readonly answer: (callIndex: number, userId: string) => Promise<void>;
} {
  const answers: ((user: { readonly userId: string }) => void)[] = [];
  return {
    readViewerUser: () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
    answer: async (callIndex, userId) => {
      const resolve = answers[callIndex];
      if (resolve === undefined) {
        throw new Error(`no identity read number ${String(callIndex)} is out`);
      }
      resolve({ userId });
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

interface IdentityProps {
  readonly sessionId: string;
}

describe("the terminal viewer identity", () => {
  it("is not loaded until the read lands, then names the user it returned", async () => {
    const held = heldRead();
    const bridge = freshBridge();
    const { result } = renderHook(() =>
      useTerminalViewerIdentity(bridge, "session-one", held.readViewerUser),
    );
    expect(result.current).toStrictEqual({ status: "not-loaded" });

    await held.answer(0, "user-one");

    expect(result.current).toStrictEqual({ status: "read", userId: "user-one" });
  });

  it("reverts to not-loaded for a different session, then reads that session's user", async () => {
    const held = heldRead();
    const bridge = freshBridge();
    const { result, rerender } = renderHook(
      (props: IdentityProps) =>
        useTerminalViewerIdentity(bridge, props.sessionId, held.readViewerUser),
      { initialProps: { sessionId: "session-one" } },
    );
    await held.answer(0, "user-one");
    expect(result.current).toStrictEqual({ status: "read", userId: "user-one" });

    rerender({ sessionId: "session-another" });
    expect(result.current).toStrictEqual({ status: "not-loaded" });

    await held.answer(1, "user-another");
    expect(result.current).toStrictEqual({ status: "read", userId: "user-another" });
  });

  it("writes nothing when the read for the session it left lands late", async () => {
    const held = heldRead();
    const bridge = freshBridge();
    const { result, rerender } = renderHook(
      (props: IdentityProps) =>
        useTerminalViewerIdentity(bridge, props.sessionId, held.readViewerUser),
      { initialProps: { sessionId: "session-one" } },
    );
    rerender({ sessionId: "session-another" });

    await held.answer(0, "user-one");

    expect(result.current).toStrictEqual({ status: "not-loaded" });
  });
});
