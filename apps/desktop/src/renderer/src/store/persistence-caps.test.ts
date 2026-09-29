import { describe, expect, it } from "vitest";

import { PERSISTENCE_QUOTA_PRESSURE_RATIO } from "./persistence-caps.js";

describe("the storage pressure gauge", () => {
  it("reports pressure before the quota is gone rather than at the moment it is", () => {
    // At 1 the gauge fires only once writing has already failed; at 0 it is always in
    // pressure and nobody reads it.
    expect(PERSISTENCE_QUOTA_PRESSURE_RATIO).toBeGreaterThan(0);
    expect(PERSISTENCE_QUOTA_PRESSURE_RATIO).toBeLessThan(1);
  });
});
