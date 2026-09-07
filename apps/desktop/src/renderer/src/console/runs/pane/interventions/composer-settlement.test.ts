// Which answers close the form, which keep it open, and which latch its confirm.
//
// Driven on the model rather than through the rendered form, because the claim is
// about a mapping over the daemon's own `state` — every arm of it, including the two
// the rendered cases never reach.

import { describe, expect, it } from "vitest";
import type {
  InterventionRequestResponse,
  RollbackCompositeRejectionGuard,
} from "@ai-sidekicks/contracts";

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

/**
 * One rejected rewind, with the daemon's typed guard where it raised one.
 *
 * The guard cases compose a rollback rather than reusing the steer helper because
 * `rejectionGuard` is scoped to the rollback `rejected` arm: only a rollback request
 * can be a composite, and the contract declares the member `never` everywhere else.
 */
function rejectedRewind(
  rejectionReason: string,
  rejectionGuard?: RollbackCompositeRejectionGuard,
): RunControlOutcome {
  return {
    kind: "settled",
    control: "rollback",
    response: {
      interventionId: "6a3b1c72-90de-4f15-8b27-4c0d9e3a5178",
      interventionType: "rollback",
      state: "rejected",
      runVersion: 9,
      rejectionReason,
      ...(rejectionGuard === undefined ? {} : { rejectionGuard }),
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

describe("what the form says beside a rejected settlement", () => {
  /** The sentence the form renders, off whichever arm the settlement landed on. */
  function detailOf(outcome: RunControlOutcome): string {
    const settlement = readComposerSettlement(outcome);
    return settlement.kind === "refused" ? settlement.notice.detail : "";
  }

  it("names the guard's act where the daemon named one of the four", () => {
    // "Change what it asks for and confirm again" names nothing a person can change
    // in this box when the blocker is an older send sitting in the queue.
    const detail = detailOf(rejectedRewind("rollback.refused", "no-pending-send"));

    expect(detail).toContain("Cancel the queued items");
    expect(detail).toContain("What you typed is still here.");
  });

  it("keeps the wire cause as the refusal's code on that path too", () => {
    const settlement = readComposerSettlement(
      rejectedRewind("rollback.refused", "no-pending-send"),
    );

    expect(settlement.kind === "refused" ? settlement.notice.code : undefined).toBe(
      "rollback.refused",
    );
  });

  it("keeps the general sentence for a rejection the wire attributed to no guard", () => {
    // The honest one when the console does not know what would make the request
    // admissible — and the negative control for the branch above.
    const detail = detailOf(rejectedRewind("run.invalid_transition"));

    expect(detail).toContain("change what it asks for");
    expect(detail).not.toContain("Cancel the queued items");
  });

  it("reads the guard and never the cause, whatever the cause happens to spell", () => {
    // The defect this path carried: the guard used to be recognised by matching
    // phrases inside `rejectionReason`, a free-form string with no registered
    // vocabulary. A cause that merely mentions a pending send is not the guard, and a
    // cause that names none is still the guard when the typed member says so.
    const spelledNotGuarded = detailOf(rejectedRewind("An earlier queued send is still pending."));
    const guardedNotSpelled = detailOf(rejectedRewind("rollback.refused", "no-pending-send"));

    expect(spelledNotGuarded).toContain("change what it asks for");
    expect(spelledNotGuarded).not.toContain("Cancel the queued items");
    expect(guardedNotSpelled).toContain("Cancel the queued items");
  });

  it("offers it for no rejected steer, which can carry no guard at all", () => {
    // The reachable second form: a steer refused because a turn is running is an
    // ordinary answer, and it used to be told to "correct the message again" about a
    // message it never corrected. The contract types the member `never` on this arm,
    // so the wire cannot attribute one here even by accident.
    const detail = detailOf(settledAt("rejected", "no_active_turn"));

    expect(detail).toContain("change what it asks for");
    expect(detail).not.toContain("Pause or stop the run first");
  });

  it("renders the daemon's own cause as the code on every one of those arms", () => {
    // Reading the guard for the SENTENCE never touches the code: the
    // machine-readable half is the daemon's on all three dispatches, and dropping it
    // would leave a refusal a person cannot look up.
    const codes = [
      readComposerSettlement(rejectedRewind("rollback.refused", "no-active-turn")),
      readComposerSettlement(rejectedRewind("rollback.refused")),
      readComposerSettlement(settledAt("rejected", "no_active_turn")),
    ].map((settlement) => (settlement.kind === "refused" ? settlement.notice.code : undefined));

    expect(codes).toStrictEqual(["rollback.refused", "rollback.refused", "no_active_turn"]);
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
