// The manual retry, and the two things a control with no rendered state has to get
// right: how many runtimes one gesture starts, and that a failed start leaves the
// control working.
//
// Nothing here renders a disabled state: the retry sits on a banner whose own presence
// is the affordance, so there is no flag to read between a double-click and two
// concurrent starts of the same runtime. The supervisor's next report is what
// eventually says `starting`, and it arrives several frames after the press — so the
// double-press case puts the second press AFTER a macrotask boundary rather than inside
// the first press's own tick, which is the harder claim and the one a person makes.
//
// AND THE SLOT HAS TO COME BACK ON EVERY WAY THE START CAN END. A key released only on
// the answered arm leaves the control dead for the life of the window the first time
// the call rejects.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { useDaemonStartAction, type DaemonStartCall } from "./shell-status-binding.js";

/** A start that records every press and answers as the case says. */
function recordingStart(starts: string[], answer: () => Promise<void>): DaemonStartCall {
  return async () => {
    starts.push("daemonStart");
    await answer();
  };
}

describe("useDaemonStartAction", () => {
  it("puts one start for a double press while the first is still running", async () => {
    // Without the guard, two presses against a start that has not answered would reach
    // the main process twice and start the same runtime concurrently.
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

  it("gives the slot back once the start has answered", async () => {
    // The positive control for the release: without it the case above is satisfied by
    // an action that takes the slot once and never returns it, which is a control that
    // works exactly one time per window.
    const starts: string[] = [];
    const start = recordingStart(starts, () => Promise.resolve());
    const { result } = renderHook(() => useDaemonStartAction(start));

    await result.current();
    await result.current();

    expect(starts).toStrictEqual(["daemonStart", "daemonStart"]);
  });

  it("gives the slot back when the start REJECTS, and hands over the rejection", async () => {
    // A rejected start ended the act as surely as an answered one, and leaving the key
    // held would kill the one control a stopped runtime has left.
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
