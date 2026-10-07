// The arms the rendered cases never reach: an expiry or a failed dispatch keeps the form and its
// text, and an intervention recorded but not applied latches the confirm, since a second one would
// double it.

import { describe, expect, it } from "vitest";
import type { InterventionRequestResponse } from "@ai-sidekicks/contracts/run/control";

import { readInterventionFormSettlement } from "./form-settlement.js";
import type { RunControlOutcome } from "../run/controls/services/dispatch.js";

/** One settled dispatch, at one daemon state. */
function settledAt(
  state: InterventionRequestResponse["state"],
  reasons: { readonly failureReason?: string } = {},
): RunControlOutcome {
  return {
    kind: "settled",
    control: "steer",
    response: {
      interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
      interventionType: "steer",
      state,
      runVersion: 9,
      ...reasons,
    } as InterventionRequestResponse,
  };
}

describe("only a settlement that landed closes the form", () => {
  it("keeps the form open on an expiry, and on a failed dispatch under its reason", () => {
    expect(readInterventionFormSettlement(settledAt("expired")).kind).toBe("refused");
    const failed = readInterventionFormSettlement(
      settledAt("failed", { failureReason: "driver.transport_closed" }),
    );
    expect(failed).toEqual({ kind: "undelivered", failureReason: "driver.transport_closed" });
  });

  it("latches the confirm on an intervention recorded and not yet applied", () => {
    // Confirming twice there would raise a second intervention, so cancel is the way out.
    expect(readInterventionFormSettlement(settledAt("requested")).kind).toBe("recorded");
    expect(readInterventionFormSettlement(settledAt("accepted")).kind).toBe("recorded");
  });
});
