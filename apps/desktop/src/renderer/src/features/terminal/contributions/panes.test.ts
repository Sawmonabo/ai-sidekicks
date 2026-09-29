// The terminal feature's registration terms, and the lease transitions its fixture
// plays.
//
// The event kind and the reason vocabulary are IMPORTED from the fold rather than
// restated here, so this file checks the fixture against the set the reader
// actually accepts. A second copy of the list would pass while the two drifted,
// which is the failure the check exists to prevent.
//
// The second half is the one that earns a test. The reader accepts only the wire's
// closed reason set and reads everything else as an unread transition, so a fixture
// that scripted a reason outside the set, or only some of the three, would drive the
// fold down arms the daemon never takes. So the fixture is held to reaching the take
// and both automatic releases, asserted against the wire's own closed set rather than
// against whatever the scenario happens to contain.

import { describe, expect, it } from "vitest";
import {
  TERMINAL_LEASE_SCENARIO,
  TERMINAL_LEASE_SCENARIO_ID,
} from "../../../../../../fixtures/scenarios/terminal-lease.js";
import { PaneRegistry } from "@renderer/console/seats/index.js";
import {
  TERMINAL_LEASE_EVENT_KIND as LEASE_TRANSITION_KIND,
  TERMINAL_LEASE_TRANSITION_REASONS as LEASE_TRANSITION_REASONS,
} from "../lease/lease-transition.js";
import { registerTerminalPane } from "./panes.js";

function leaseTransitionReasons(): readonly unknown[] {
  return TERMINAL_LEASE_SCENARIO.beats
    .filter((beat) => beat.event.kind === LEASE_TRANSITION_KIND)
    .map((beat) => beat.event.payload?.["reason"]);
}

describe("terminal feature — claiming the pane layout's terminal pane", () => {
  it("claims the terminal kind on terms the pane layout can hold it by", () => {
    const registry = new PaneRegistry();
    registerTerminalPane(registry);
    const descriptor = registry.descriptorFor("terminal");
    expect(descriptor?.kind).toBe("terminal");
    expect(descriptor?.owner).toBe("terminal");
    // Kind and owner are the whole registration: whether the kind may be torn off
    // is the window model's answer, and `routing/panes/pane-kinds.test.ts` holds it.
  });

  it("claims exactly one kind — V1 has one terminal per session", () => {
    const registry = new PaneRegistry();
    registerTerminalPane(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual(["terminal"]);
  });

  it("negative control: a second owner claiming the kind is refused, not swapped", () => {
    const registry = new PaneRegistry();
    registerTerminalPane(registry);
    expect(() => {
      registry.register({
        kind: "terminal",
        owner: "another-owner",
        render: () => null,
      });
    }).toThrow();
  });
});

describe("terminal scenario — the take and the two automatic releases", () => {
  it("carries the id its module exports", () => {
    expect(TERMINAL_LEASE_SCENARIO.id).toBe(TERMINAL_LEASE_SCENARIO_ID);
    expect(leaseTransitionReasons().length).toBeGreaterThan(0);
  });

  it("reaches every reason in the closed set", () => {
    expect([...new Set(leaseTransitionReasons())].sort()).toStrictEqual(
      [...LEASE_TRANSITION_REASONS].sort(),
    );
  });

  it("names a holder on a take and nulls it on every release", () => {
    for (const beat of TERMINAL_LEASE_SCENARIO.beats) {
      if (beat.event.kind !== LEASE_TRANSITION_KIND) {
        continue;
      }
      const payload = beat.event.payload ?? {};
      const isTake = payload["reason"] === "taken";
      // A free lease is an explicit state, so the member is present and null
      // rather than omitted — omission would read as "the wire did not say".
      expect(Object.hasOwn(payload, "holderUserId")).toBe(true);
      expect(payload["holderUserId"] === null).toBe(!isTake);
      expect(Object.hasOwn(payload, "previousHolderUserId")).toBe(true);
    }
  });

  it("negative control: a reason outside the set is not in it", () => {
    // Every case above would pass over a comparison that accepted anything, and
    // over a scenario that scripted a fourth reason nobody registered.
    expect(LEASE_TRANSITION_REASONS).not.toContain("auto_released_timeout");
    expect(leaseTransitionReasons()).not.toContain("auto_released_timeout");
  });
});
