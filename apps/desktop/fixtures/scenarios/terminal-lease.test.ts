// What the terminal-lease scenario promises the pane built against it.
//
// WIRE TRUTH IS NOT HERE, AND DELIBERATELY SO.
// `tests/helpers/scenario-contract-check/contract-check.ts` is the one predicate every
// scenario in the catalog is measured through — the event census, the canonical
// envelope, the log position and tick each beat takes, and one scripted answer per call —
// and this scenario is in the catalog, so every one of those legs already runs against it.
//
// WHAT IS HERE IS WHAT NOTHING ELSE COVERS: the lease the script has to end on.

// Every clean assertion below has a negative control that fails, because a
// predicate that accepted everything would satisfy the positive half of all of
// them.

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
   * The last lease transition the script plays.
   *
   * Found rather than named by sequence: the script grows beats when a transition
   * gains the acquisition it needed, and a hard-coded ordinal turns that into a
   * silently vacuous filter — the control below would then remove nothing and pass
   * against the very script it exists to reject.
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
    // It is the last transition, so a script that ended on a plain release would pin
    // a frame with no holder — and the held frame is what `runToCompletion()` pins.
    expect(holderAfter(TERMINAL_LEASE_SCENARIO.beats)).toBe(
      TERMINAL_LEASE_SCENARIO.userIdsInJoinOrder[0],
    );
  });

  it("would notice a script that ended free", () => {
    // The same function over the script with its final take removed — which is
    // exactly the mistake it exists to catch, and which a run of automatic releases
    // makes easy to leave behind.
    const withoutFinalTake = TERMINAL_LEASE_SCENARIO.beats.filter(
      (beat) => beat !== finalLeaseTransition(),
    );
    expect(holderAfter(withoutFinalTake)).toBeNull();
  });
});
