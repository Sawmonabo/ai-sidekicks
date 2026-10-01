// A double press must start the runtime once, and the key must come back however the start ends.
// The second press lands after a macrotask boundary, the way a person's does.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { useDaemonStartAction, type DaemonStartCall } from "./useDaemonStartAction.js";

/** A start that records every press and answers as the case says. */
function recordingStart(starts: string[], answer: () => Promise<void>): DaemonStartCall {
  return async () => {
    starts.push("daemonStart");
    await answer();
  };
}

describe("useDaemonStartAction", () => {
  it("puts one start for a double press while the first is still running", async () => {
    // Without the guard, two presses reach the main process and start the runtime twice.
    const starts: string[] = [];
    let answerFirstPress!: () => void;
    const held = new Promise<void>((resolve) => {
      answerFirstPress = resolve;
    });
    const { result } = renderHook(() => useDaemonStartAction(recordingStart(starts, () => held)));

    const firstPress = result.current();
    await crossMacrotaskBoundary();
    await result.current();

    expect(starts).toStrictEqual(["daemonStart"]);

    answerFirstPress();
    await firstPress;
  });

  it("gives the key back when the start REJECTS, and hands over the rejection", async () => {
    // A rejected start ends the act too; a held key would kill the control.
    const starts: string[] = [];
    const start = recordingStart(starts, () =>
      Promise.reject(new Error("the main process could not reach the supervisor")),
    );
    const { result } = renderHook(() => useDaemonStartAction(start));

    await expect(result.current()).rejects.toThrow("could not reach the supervisor");
    await expect(result.current()).rejects.toThrow("could not reach the supervisor");

    expect(starts).toStrictEqual(["daemonStart", "daemonStart"]);
  });
});
