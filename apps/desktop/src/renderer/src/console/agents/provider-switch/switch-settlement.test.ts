// The settlement projection, arm by arm.
//
// What is worth checking here is exactly what the design forbids: re-deriving
// `degraded` from `continuity`, treating an empty loss list as a warning, dropping a
// member a later amendment added, and rendering the failed arm as a switch.

import { describe, expect, it } from "vitest";

import { describeSwitchSettlement } from "./switch-settlement.js";

describe("switch settlement — the four arms", () => {
  it("names the boundary on the pending arm, quoted from the reply", () => {
    const rendering = describeSwitchSettlement(
      { status: "pending", appliesAt: "run_boundary" },
      "Scout",
    );
    expect(rendering.headline).toContain("at the next run boundary");
    expect(rendering.tone).toBe("stated");
  });

  it("negative control: the turn boundary reads differently from the run boundary", () => {
    // Without this, a projection that printed one fixed phrase would pass above.
    const rendering = describeSwitchSettlement(
      { status: "pending", appliesAt: "turn_boundary" },
      "Scout",
    );
    expect(rendering.headline).toContain("at the next turn boundary");
    expect(rendering.headline).not.toContain("run boundary");
  });

  it("reads the failed arm as a caution that names what stayed", () => {
    const rendering = describeSwitchSettlement(
      { status: "failed", reason: "interrupt_refused" },
      "Scout",
    );
    expect(rendering.tone).toBe("caution");
    expect(rendering.headline).toContain("did not switch");
    expect(rendering.headline).toContain("interrupt was refused");
  });

  it("negative control: a degraded settlement is not a caution", () => {
    // The memo arm is a real switch with a real loss, and decorating it as a failure
    // would be false — which is the distinction the tone carries.
    const rendering = describeSwitchSettlement(
      { status: "degraded", continuity: "memo", declaredLosses: ["context_truncated"] },
      "Scout",
    );
    expect(rendering.tone).toBe("stated");
    expect(rendering.headline).toContain("switched");
  });
});

describe("switch settlement — declared losses", () => {
  it("reads an empty list as a positive assertion that nothing was dropped", () => {
    const rendering = describeSwitchSettlement(
      { status: "applied", continuity: "replayed", declaredLosses: [] },
      "Scout",
    );
    expect(rendering.lossClause).toBe("Nothing was dropped.");
  });

  it("negative control: an ABSENT list asserts nothing and gets no clause", () => {
    // Absent and empty are different facts; a projection that flattened them would
    // print "nothing was dropped" for a reply that made no such claim.
    const rendering = describeSwitchSettlement(
      { status: "applied", continuity: "in_place" },
      "Scout",
    );
    expect(rendering.lossClause).toBeUndefined();
  });

  it("names each loss in plain words", () => {
    const rendering = describeSwitchSettlement(
      {
        status: "degraded",
        continuity: "memo",
        declaredLosses: ["provider_private_reasoning", "turn_content_truncated"],
      },
      "Scout",
    );
    expect(rendering.lossClause).toContain("private reasoning");
    expect(rendering.lossClause).toContain("prefix");
  });
});

describe("switch settlement — members this console does not know", () => {
  it("renders an unrecognized status as itself rather than guessing an arm", () => {
    const rendering = describeSwitchSettlement({ status: "quarantined" }, "Scout");
    expect(rendering.isKnownStatus).toBe(false);
    expect(rendering.headline).toContain("quarantined");
  });

  it("negative control: a known status is reported known", () => {
    const rendering = describeSwitchSettlement({ status: "applied" }, "Scout");
    expect(rendering.isKnownStatus).toBe(true);
  });

  it("renders an unrecognized loss kind rather than dropping it", () => {
    const rendering = describeSwitchSettlement(
      { status: "degraded", continuity: "memo", declaredLosses: ["attachments_stripped"] },
      "Scout",
    );
    expect(rendering.lossClause).toContain("attachments_stripped");
  });

  it("renders an unrecognized continuity rather than dropping it", () => {
    const rendering = describeSwitchSettlement(
      { status: "applied", continuity: "forked" },
      "Scout",
    );
    expect(rendering.continuityClause).toContain("forked");
  });
});

describe("switch settlement — supersession", () => {
  it("carries the displaced id, which is the only record a superseded intent gets", () => {
    const rendering = describeSwitchSettlement(
      { status: "pending", appliesAt: "turn_boundary", replacedSwitchId: "switch-7" },
      "Scout",
    );
    expect(rendering.supersededSwitchId).toBe("switch-7");
  });

  it("negative control: a first switch displaces nothing", () => {
    const rendering = describeSwitchSettlement(
      { status: "pending", appliesAt: "turn_boundary" },
      "Scout",
    );
    expect(rendering.supersededSwitchId).toBeUndefined();
  });
});
