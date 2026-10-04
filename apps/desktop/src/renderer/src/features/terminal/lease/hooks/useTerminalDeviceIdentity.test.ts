// `useTerminalDeviceIdentity` driven with a read each case answers by hand. The identity
// belongs to the inputs that produced it: a different session reverts to `not-loaded` on the
// first frame, and a read that lands after its inputs were left settles nothing.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { terminalFixtureBridge } from "../../pane/components/TerminalPane.test-support.js";
import {
  useTerminalDeviceIdentity,
  type ReadTerminalDeviceIdentity,
} from "./useTerminalDeviceIdentity.js";

/** A read the case answers by hand, keyed by the order the reads were made in. */
function heldRead(): {
  readonly readDeviceIdentity: ReadTerminalDeviceIdentity;
  readonly answer: (callIndex: number, deviceId: string) => Promise<void>;
} {
  const answers: ((identity: { readonly deviceId: string }) => void)[] = [];
  return {
    readDeviceIdentity: () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
    answer: async (callIndex, deviceId) => {
      const resolve = answers[callIndex];
      if (resolve === undefined) {
        throw new Error(`no identity read number ${String(callIndex)} is out`);
      }
      resolve({ deviceId });
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
  it(
    "reverts to not-loaded for a different session, then reads that " + "session's device",
    async () => {
      const held = heldRead();
      const bridge = terminalFixtureBridge();
      const { result, rerender } = renderHook(
        (props: IdentityProps) =>
          useTerminalDeviceIdentity(bridge, props.sessionId, held.readDeviceIdentity),
        { initialProps: { sessionId: "session-one" } },
      );
      await held.answer(0, "device-one");
      expect(result.current).toStrictEqual({ status: "read", deviceId: "device-one" });

      rerender({ sessionId: "session-another" });
      expect(result.current).toStrictEqual({ status: "not-loaded" });

      await held.answer(1, "device-another");
      expect(result.current).toStrictEqual({ status: "read", deviceId: "device-another" });
    },
  );

  it("writes nothing when the read for the session it left lands late", async () => {
    const held = heldRead();
    const bridge = terminalFixtureBridge();
    const { result, rerender } = renderHook(
      (props: IdentityProps) =>
        useTerminalDeviceIdentity(bridge, props.sessionId, held.readDeviceIdentity),
      { initialProps: { sessionId: "session-one" } },
    );
    rerender({ sessionId: "session-another" });

    await held.answer(0, "device-one");

    expect(result.current).toStrictEqual({ status: "not-loaded" });
  });
});
