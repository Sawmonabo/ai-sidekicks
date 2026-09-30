// The agent hue wheel handed to an unbounded population: twelve steps, and running out must not
// draw two agents alike while a step is still free. A happy-path test with three agents never
// reaches the wrap.

import { describe, expect, it } from "vitest";

import { HUE_WHEEL_STEPS } from "./palette.js";
import { AgentHueAllocator } from "./agent-hue.js";

describe("the agent hue wheel runs out of steps", () => {
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
});
