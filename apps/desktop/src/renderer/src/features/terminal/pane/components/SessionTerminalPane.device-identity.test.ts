// `useTerminalDeviceIdentity` driven with a read each case answers by hand. The identity
// belongs to the inputs that produced it: a different session reverts to `not-loaded` on the
// first frame, and a read that lands after its inputs were left settles nothing.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import {
  useTerminalDeviceIdentity,
  type ReadTerminalDeviceUser,
} from "../../lease/hooks/useTerminalDeviceIdentity.js";

function freshBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("terminal-device-identity") }).bridge;
}

/** A read the case answers by hand, keyed by the order the reads were made in. */
function heldRead(): {
  readonly readDeviceUser: ReadTerminalDeviceUser;
  readonly answer: (callIndex: number, userId: string) => Promise<void>;
} {
  const answers: ((user: { readonly userId: string }) => void)[] = [];
  return {
    readDeviceUser: () =>
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

describe("the terminal device identity", () => {
  it("reverts to not-loaded for a different session, then reads that session's user", async () => {
    const held = heldRead();
    const bridge = freshBridge();
    const { result, rerender } = renderHook(
      (props: IdentityProps) =>
        useTerminalDeviceIdentity(bridge, props.sessionId, held.readDeviceUser),
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
        useTerminalDeviceIdentity(bridge, props.sessionId, held.readDeviceUser),
      { initialProps: { sessionId: "session-one" } },
    );
    rerender({ sessionId: "session-another" });

    await held.answer(0, "user-one");

    expect(result.current).toStrictEqual({ status: "not-loaded" });
  });
});
