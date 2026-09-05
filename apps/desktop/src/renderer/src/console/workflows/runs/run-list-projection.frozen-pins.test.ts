// The pin a run is frozen at, held against the definition's own latest.
//
// The reading is a comparison rather than a flag on the wire, so what it owes is the
// third case: absent a latest to compare against there is nothing to say, and saying
// `true` would invite a repair the daemon would refuse.

import { describe, expect, it } from "vitest";

import { RunListProjection } from "./run-list-projection.js";
import { run } from "./run-list-projection.test-support.js";

describe("the frozen-definition state", () => {
  it("is true when the run's pin is not the definition's latest", () => {
    const projection = new RunListProjection([
      run({ workflowVersionId: "version-1", definitionLatestWorkflowVersionId: "version-4" }),
    ]);
    expect(projection.rows[0]?.isPinnedBehindLatestVersion).toBe(true);
    expect(projection.frozenPinCount).toBe(1);
  });

  it("is false when the pin IS the latest", () => {
    const projection = new RunListProjection([
      run({ workflowVersionId: "version-4", definitionLatestWorkflowVersionId: "version-4" }),
    ]);
    expect(projection.rows[0]?.isPinnedBehindLatestVersion).toBe(false);
  });

  it("negative control: unknown latest is not stale", () => {
    // Without the caller's latest there is no comparison to make, and guessing
    // `true` would invite a repair the daemon would refuse. The control matters
    // because `undefined !== "version-1"` is true, which is exactly the shape a
    // careless implementation reports as frozen.
    const projection = new RunListProjection([run({ workflowVersionId: "version-1" })]);
    expect(projection.rows[0]?.isPinnedBehindLatestVersion).toBe(false);
    expect(projection.frozenPinCount).toBe(0);
  });
});
