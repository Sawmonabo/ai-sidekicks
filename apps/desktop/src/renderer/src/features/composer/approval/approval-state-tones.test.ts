import { describe, expect, it } from "vitest";

import { APPROVAL_STATE_TONES } from "./approval-state-tones.js";
import { APPROVAL_STATES } from "@renderer/lib/approval-vocabulary.js";

describe("the chip tone each approval state wears", () => {
  it("names a tone for every state", () => {
    for (const state of APPROVAL_STATES) {
      expect(APPROVAL_STATE_TONES[state]).toBeTypeOf("string");
    }
  });

  it("spends amber on `pending` alone, so a needed person is the only amber", () => {
    const amberStates = APPROVAL_STATES.filter(
      (state) => APPROVAL_STATE_TONES[state] === "attention",
    );
    expect(amberStates).toStrictEqual(["pending"]);
  });
});
