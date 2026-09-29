// Failure modes of the agent hue wheel.
//
// The wheel is a finite resource handed out to an unbounded population, so every mode
// here is what happens when it runs out or is asked twice: a thirteenth agent arrives
// and there are twelve steps, or an agent leaves and its color is a candidate for reuse.
// The failure is not a crash, the wheel wraps happily; it is two agents drawn alike in
// a crowded wrap, or one agent's color changing under it and re-attributing the rows
// above. Neither is reachable from a happy-path test with three agents in it.

import { describe, expect, it } from "vitest";

import { ACTOR_HUE_STEPS } from "./palette.js";
import { AgentHueAllocator } from "./agent-hue.js";

describe("failure matrix — the agent hue wheel runs out of steps", () => {
  it("uses every step before any repeats, and wraps evenly past twelve", () => {
    const allocator = new AgentHueAllocator();
    const agentIds = Array.from(
      { length: ACTOR_HUE_STEPS * 2 + 3 },
      (_unused, index) => `agent-${String(index)}`,
    );

    const assignments = agentIds.map((agentId) => allocator.admit(agentId));

    expect(allocator.admittedCount).toBe(agentIds.length);
    const firstTwelve = assignments.slice(0, ACTOR_HUE_STEPS);
    expect(new Set(firstTwelve.map((one) => one.step)).size).toBe(ACTOR_HUE_STEPS);
    expect(firstTwelve.some((one) => one.sharesStepWithEarlierUser)).toBe(false);
    // Past twelve, no step holds two more occupants than another.
    const occupants = new Array<number>(ACTOR_HUE_STEPS).fill(0);
    for (const one of assignments) {
      occupants[one.step] = (occupants[one.step] ?? 0) + 1;
    }
    expect(Math.max(...occupants) - Math.min(...occupants)).toBeLessThanOrEqual(1);
    expect(assignments.slice(ACTOR_HUE_STEPS).every((one) => one.sharesStepWithEarlierUser)).toBe(
      true,
    );
  });

  it("frees nothing when an agent leaves, so a color never changes hands", () => {
    const allocator = new AgentHueAllocator();
    const leaving = allocator.admit("agent-leaving");
    // There is deliberately no `release`. Re-using a departed agent's hue would silently
    // re-attribute its rows above.
    expect("release" in allocator).toBe(false);
    const later = allocator.admit("agent-later");
    expect(later.step).not.toBe(leaving.step);
  });
});
