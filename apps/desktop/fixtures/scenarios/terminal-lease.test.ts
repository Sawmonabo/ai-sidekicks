// What the terminal-lease scenario promises the pane built against it: the lease the script
// ends on. Wire truth is checked for every catalog scenario by
// `tests/helpers/scenario-contract-check/contract-check.ts`, so it is not repeated here.
//
// Every clean assertion has a negative control that fails, so a predicate that accepted
// everything could not satisfy them all.

import { describe, expect, it } from "vitest";
import { TERMINAL_LEASE_SCENARIO } from "./terminal-lease.js";
import type { ScenarioBeat } from "../scenario.js";

describe("the terminal scenario ends held", () => {
  /** Who holds the lease once these beats have played, or `null` for a free one. */
  function holderAfter(beats: readonly ScenarioBeat[]): unknown {
    return beats
      .filter((beat) => beat.event.kind === "pty.control_changed")
      .map((beat) => beat.event.payload?.["holderDeviceId"])
      .at(-1);
  }

  /**
   * The last lease transition the script plays, found rather than named by sequence so a
   * new beat cannot turn the control below into a filter that removes nothing.
   */
  function finalLeaseTransition(): ScenarioBeat {
    const transitions = TERMINAL_LEASE_SCENARIO.beats.filter(
      (beat) => beat.event.kind === "pty.control_changed",
    );
    const newest = transitions.at(-1);
    if (newest === undefined) {
      throw new Error("the terminal scenario scripts no lease transition");
    }
    return newest;
  }

  it("leaves the lease held at the last transition", () => {
    // A script ending on a plain release would pin a frame with no holder, and the held
    // frame is what `runToCompletion()` pins.
    expect(holderAfter(TERMINAL_LEASE_SCENARIO.beats)).toBe(
      TERMINAL_LEASE_SCENARIO.userIdsInJoinOrder[0],
    );
  });

  it("would notice a script that ended free", () => {
    // The same function over the script with its final take removed, the mistake it exists
    // to catch.
    const withoutFinalTake = TERMINAL_LEASE_SCENARIO.beats.filter(
      (beat) => beat !== finalLeaseTransition(),
    );
    expect(holderAfter(withoutFinalTake)).toBeNull();
  });
});
