// A refused stop or restart names the other clients still connected, and its count is exactly
// that list.
import { describe, expect, it } from "vitest";

import { DaemonLifecycleConflictDetailsSchema } from "../daemon-lifecycle.js";

describe("daemon.stop and daemon.restart", () => {
  it("names every other client still connected, and counts exactly those", () => {
    expect(
      DaemonLifecycleConflictDetailsSchema.safeParse({
        activeClientCount: 2,
        observedClientIds: ["cli-1", "desktop-2"],
      }).success,
    ).toBe(true);
    expect(
      DaemonLifecycleConflictDetailsSchema.safeParse({
        activeClientCount: 3,
        observedClientIds: ["cli-1", "desktop-2"],
      }).success,
    ).toBe(false);
    expect(
      DaemonLifecycleConflictDetailsSchema.safeParse({
        activeClientCount: 0,
        observedClientIds: [],
      }).success,
    ).toBe(false);
  });
});
