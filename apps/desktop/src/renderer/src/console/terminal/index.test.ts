// The terminal family's registration terms, and the lease transitions its fixture
// plays.
//
// The event kind and the reason vocabulary are IMPORTED from the fold rather than
// restated here, so this file checks the fixture against the set the surface
// actually renders. A second copy of the list would pass while the two drifted,
// which is the failure the check exists to prevent.
//
// The second half is the one that earns a test. `Spec-023 §Console Design
// (Meridian)` 8.8 requires every transition to render as a ledger line naming its
// reason, with the three AUTOMATIC reasons kept distinct — a surface that collapsed
// them into "the lease was released" would look right against a fixture that only
// ever scripted two of the five. So the fixture is held to reaching all five, and
// the vocabulary is asserted against `Spec-006`'s own closed set rather than
// against whatever the scenario happens to contain.

import { describe, expect, it } from "vitest";

import { TERMINAL_SCENARIO, TERMINAL_SCENARIO_ID } from "../bridge/scenarios/terminal.js";
import { ConsolePaneRegistry } from "../seats/index.js";
import {
  TERMINAL_LEASE_EVENT_KIND as LEASE_TRANSITION_KIND,
  TERMINAL_LEASE_TRANSITION_REASONS as LEASE_TRANSITION_REASONS,
} from "./lease-model.js";
import { registerTerminalPanes } from "./index.js";

function leaseTransitionReasons(): readonly unknown[] {
  return TERMINAL_SCENARIO.beats
    .filter((beat) => beat.event.kind === LEASE_TRANSITION_KIND)
    .map((beat) => beat.event.payload?.["reason"]);
}

describe("terminal family — claiming the deck's terminal pane", () => {
  it("claims the terminal kind on terms the deck can hold it by", () => {
    const registry = new ConsolePaneRegistry();
    registerTerminalPanes(registry);
    const descriptor = registry.descriptorFor("terminal");
    expect(descriptor?.kind).toBe("terminal");
    expect(descriptor?.owner).toBe("terminal");
    // Kind and owner are the whole registration: whether the kind may be torn off
    // is the window model's answer, and `seats/pane-kinds.test.ts` holds it.
  });

  it("claims exactly one kind — V1 has one terminal per session", () => {
    const registry = new ConsolePaneRegistry();
    registerTerminalPanes(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual(["terminal"]);
  });

  it("negative control: a second owner claiming the kind is refused, not swapped", () => {
    const registry = new ConsolePaneRegistry();
    registerTerminalPanes(registry);
    expect(() => {
      registry.register({
        kind: "terminal",
        owner: "some-other-family",
        render: () => null,
      });
    }).toThrow();
  });
});

describe("terminal scenario — all five transition reasons, kept distinct", () => {
  it("is the scenario the seat board names", () => {
    expect(TERMINAL_SCENARIO.id).toBe(TERMINAL_SCENARIO_ID);
    expect(leaseTransitionReasons().length).toBeGreaterThan(0);
  });

  it("reaches every reason in the closed set", () => {
    expect([...new Set(leaseTransitionReasons())].sort()).toStrictEqual(
      [...LEASE_TRANSITION_REASONS].sort(),
    );
  });

  it("names a holder on a take and nulls it on every release", () => {
    for (const beat of TERMINAL_SCENARIO.beats) {
      if (beat.event.kind !== LEASE_TRANSITION_KIND) {
        continue;
      }
      const payload = beat.event.payload ?? {};
      const isTake = payload["reason"] === "taken";
      // A free lease is an explicit state, so the member is present and null
      // rather than omitted — omission would read as "the wire did not say".
      expect(Object.hasOwn(payload, "holderParticipantId")).toBe(true);
      expect(payload["holderParticipantId"] === null).toBe(!isTake);
      expect(Object.hasOwn(payload, "previousHolderParticipantId")).toBe(true);
    }
  });

  it("negative control: a reason outside the set is not in it", () => {
    // Every case above would pass over a comparison that accepted anything, and
    // over a scenario that scripted a sixth reason nobody registered.
    expect(LEASE_TRANSITION_REASONS).not.toContain("auto_released_timeout");
    expect(leaseTransitionReasons()).not.toContain("auto_released_timeout");
  });
});
