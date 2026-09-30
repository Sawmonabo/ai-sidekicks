// Failure modes of the agent hue wheel: twelve steps handed to an unbounded population. Running
// out does not crash; it draws two agents alike in a crowded wrap, and a reused color would
// re-attribute an agent's earlier rows. A happy-path test with three agents reaches neither.

import { describe, expect, it } from "vitest";

import { HUE_WHEEL_STEPS } from "./palette.js";
import { AgentHueAllocator } from "./agent-hue.js";

describe("failure matrix — the agent hue wheel runs out of steps", () => {
  it("uses every step before any repeats, and wraps evenly past twelve", () => {
    const allocator = new AgentHueAllocator();
    const agentIds = Array.from(
      { length: HUE_WHEEL_STEPS * 2 + 3 },
      (_unused, index) => `agent-${String(index)}`,
    );

    const assignments = agentIds.map((agentId) => allocator.admit(agentId));

    expect(allocator.admittedCount).toBe(agentIds.length);
    const firstTwelve = assignments.slice(0, HUE_WHEEL_STEPS);
    expect(new Set(firstTwelve.map((one) => one.step)).size).toBe(HUE_WHEEL_STEPS);
    expect(firstTwelve.some((one) => one.sharesStepWithEarlierUser)).toBe(false);
    // Past twelve, no step holds two more occupants than another.
    const occupants = new Array<number>(HUE_WHEEL_STEPS).fill(0);
    for (const one of assignments) {
      occupants[one.step] = (occupants[one.step] ?? 0) + 1;
    }
    expect(Math.max(...occupants) - Math.min(...occupants)).toBeLessThanOrEqual(1);
    expect(assignments.slice(HUE_WHEEL_STEPS).every((one) => one.sharesStepWithEarlierUser)).toBe(
      true,
    );
  });

  it("frees nothing when an agent leaves, so a color never changes hands", () => {
    const allocator = new AgentHueAllocator();
    const leaving = allocator.admit("agent-leaving");
    // There is deliberately no `release`: reusing a departed agent's hue would re-attribute its
    // rows.
    expect("release" in allocator).toBe(false);
    const later = allocator.admit("agent-later");
    expect(later.step).not.toBe(leaving.step);
  });
});
