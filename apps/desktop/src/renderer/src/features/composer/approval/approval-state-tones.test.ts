import { APPROVAL_STATES } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { APPROVAL_STATE_TONES } from "./approval-state-tones.js";

describe("the chip tone each approval state wears", () => {
  it("spends amber on `pending` alone, so a needed person is the only amber", () => {
    const amberStates = APPROVAL_STATES.filter(
      (state) => APPROVAL_STATE_TONES[state] === "attention",
    );
    expect(amberStates).toStrictEqual(["pending"]);
  });
});
