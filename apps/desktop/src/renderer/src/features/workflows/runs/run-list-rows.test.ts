// The park discriminator is `parkReason` and never a phase's `state`, so a park on a `running`
// phase is still a park.

import { describe, expect, it } from "vitest";

import { phasePark } from "./run-list-rows.js";
import { phase } from "./run-list-projection.test-support.js";

describe("the park discriminator", () => {
  it("reads a park off `parkReason` even on a phase whose state says running", () => {
    const park = phasePark(
      phase({ state: "running", parkReason: "waiting-human", parkCause: "Approval needed." }),
    );
    expect(park?.parkReason).toBe("waiting-human");
  });
});
