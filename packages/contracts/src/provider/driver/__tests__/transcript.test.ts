// The compaction result's two structural rules, which a driver could otherwise break.
import { describe, expect, it } from "vitest";

import { DriverCompactionResultSchema } from "../transcript.js";

describe("DriverCompactionResultSchema — the two structural rules, made checkable", () => {
  // The compaction result is composed daemon-side from the wait's own settlement, so no dispatch
  // path parses through this schema. It exists so the two rules are enforced by the type; a later
  // widening that broke either fails here.

  it("REQUIRES `boundaryPosition` on the applied arm", () => {
    // A compaction with no boundary is one the driver cannot prove: the boundary row is the
    // typed evidence, and without it the operation could settle on the request merely having
    // been accepted.
    expect(DriverCompactionResultSchema.safeParse({ status: "applied" }).success).toBe(false);
    expect(
      DriverCompactionResultSchema.safeParse({ status: "applied", boundaryPosition: 12 }).success,
    ).toBe(true);
  });

  it("admits `capability_undeclared` as NO arm's reason", () => {
    // The static capability gate refuses an undeclared compaction before the driver is called,
    // so an arm for it would be a second, contradictory encoding of one refusal. Both
    // refusal-shaped arms are probed so the reason cannot pass by landing on the other.
    expect(
      DriverCompactionResultSchema.safeParse({
        status: "refused",
        reason: "capability_undeclared",
      }).success,
    ).toBe(false);
    expect(
      DriverCompactionResultSchema.safeParse({
        status: "failed",
        reason: "capability_undeclared",
      }).success,
    ).toBe(false);
  });
});
