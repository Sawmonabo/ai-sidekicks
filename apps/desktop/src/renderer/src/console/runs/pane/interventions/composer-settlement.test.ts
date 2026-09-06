// Which answers close the form, which keep it open, and which latch its confirm.
//
// Driven on the model rather than through the rendered form, because the claim is
// about a mapping over the daemon's own `state` — every arm of it, including the two
// the rendered cases never reach.

import { describe, expect, it } from "vitest";
import type { InterventionRequestResponse } from "@ai-sidekicks/contracts";

import { admissionRefusal, readComposerSettlement } from "./composer-settlement.js";
import type { RunControlOutcome } from "../controls/run-control-dispatch.js";

/** One settled dispatch, at one daemon state. */
function settledAt(
  state: InterventionRequestResponse["state"],
  rejectionReason?: string,
): RunControlOutcome {
  return {
    kind: "settled",
    control: "steer",
    response: {
      interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
      interventionType: "steer",
      state,
      runVersion: 9,
      ...(rejectionReason === undefined ? {} : { rejectionReason }),
    } as InterventionRequestResponse,
  };
}

describe("only a settlement that landed closes the form", () => {
  it("reads the two landed states as landed", () => {
    expect(readComposerSettlement(settledAt("applied")).kind).toBe("landed");
    expect(readComposerSettlement(settledAt("degraded")).kind).toBe("landed");
  });

  it("keeps the form open on a rejection, under the daemon's own reason", () => {
    const settlement = readComposerSettlement(settledAt("rejected", "run_not_paused"));
    expect(settlement.kind).toBe("refused");
    expect(settlement.kind === "refused" ? settlement.notice.code : undefined).toBe(
      "run_not_paused",
    );
  });

  it("falls back to the wire state where a rejection named no reason", () => {
    const settlement = readComposerSettlement(settledAt("rejected"));
    expect(settlement.kind === "refused" ? settlement.notice.code : undefined).toBe("rejected");
  });

  it("keeps the form open on an expiry", () => {
    expect(readComposerSettlement(settledAt("expired")).kind).toBe("refused");
  });

  it("latches the confirm on an intervention recorded and not yet applied", () => {
    // Confirming twice there would raise a SECOND intervention, so this arm is
    // neither landed nor retryable — it is the one that leaves cancel as the way out.
    expect(readComposerSettlement(settledAt("requested")).kind).toBe("recorded");
    expect(readComposerSettlement(settledAt("accepted")).kind).toBe("recorded");
  });

  it("keeps the form open on a refusal that never reached a state", () => {
    const settlement = readComposerSettlement({
      kind: "refused",
      control: "steer",
      refusal: { origin: "run-control", code: "run.not_found", detail: "no such run" },
    });
    expect(settlement.kind).toBe("refused");
    expect(settlement.kind === "refused" ? settlement.notice.code : undefined).toBe(
      "run.not_found",
    );
  });

  it("negative control: the arms are not all one answer", () => {
    // Without this every case above would pass over a reader that answered `refused`
    // to everything, which would leave a landed intervention's form open forever.
    const kinds = new Set(
      (["applied", "rejected", "requested"] as const).map(
        (state) => readComposerSettlement(settledAt(state)).kind,
      ),
    );
    expect(kinds).toStrictEqual(new Set(["landed", "refused", "recorded"]));
  });
});

describe("a refused admission says which reason it was", () => {
  it("names the reason as its code and says nothing was sent", () => {
    const refusal = admissionRefusal("in-flight");
    expect(refusal.code).toBe("in-flight");
    expect(refusal.detail).toContain("nothing was sent");
    expect(refusal.detail).toContain("still here");
  });
});
