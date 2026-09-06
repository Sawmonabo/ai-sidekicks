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

/**
 * One rejected rewind, which is the only dispatch that can have been a composite.
 *
 * The guard cases compose a rollback rather than reusing the steer helper, because
 * `composite` is the REQUEST's own flag — whether it carried `replacementSend` — and
 * a steer carries none however the daemon answers it.
 */
function rejectedRewind(rejectionReason: string): RunControlOutcome {
  return {
    kind: "settled",
    control: "rollback",
    response: {
      interventionId: "6a3b1c72-90de-4f15-8b27-4c0d9e3a5178",
      interventionType: "rollback",
      state: "rejected",
      runVersion: 9,
      rejectionReason,
    } as InterventionRequestResponse,
  };
}

describe("only a settlement that landed closes the form", () => {
  it("reads the two landed states as landed", () => {
    expect(readComposerSettlement(settledAt("applied"), false).kind).toBe("landed");
    expect(readComposerSettlement(settledAt("degraded"), false).kind).toBe("landed");
  });

  it("keeps the form open on a rejection, under the daemon's own reason", () => {
    const settlement = readComposerSettlement(settledAt("rejected", "run_not_paused"), false);
    expect(settlement.kind).toBe("refused");
    expect(settlement.kind === "refused" ? settlement.notice.code : undefined).toBe(
      "run_not_paused",
    );
  });

  it("falls back to the wire state where a rejection named no reason", () => {
    const settlement = readComposerSettlement(settledAt("rejected"), false);
    expect(settlement.kind === "refused" ? settlement.notice.code : undefined).toBe("rejected");
  });

  it("keeps the form open on an expiry", () => {
    expect(readComposerSettlement(settledAt("expired"), false).kind).toBe("refused");
  });

  it("latches the confirm on an intervention recorded and not yet applied", () => {
    // Confirming twice there would raise a SECOND intervention, so this arm is
    // neither landed nor retryable — it is the one that leaves cancel as the way out.
    expect(readComposerSettlement(settledAt("requested"), false).kind).toBe("recorded");
    expect(readComposerSettlement(settledAt("accepted"), false).kind).toBe("recorded");
  });

  it("keeps the form open on a refusal that never reached a state", () => {
    const settlement = readComposerSettlement(
      {
        kind: "refused",
        control: "steer",
        refusal: { origin: "run-control", code: "run.not_found", detail: "no such run" },
      },
      false,
    );
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
        (state) => readComposerSettlement(settledAt(state), false).kind,
      ),
    );
    expect(kinds).toStrictEqual(new Set(["landed", "refused", "recorded"]));
  });
});

describe("what the form says beside a rejected settlement", () => {
  /** The sentence the form renders, off whichever arm the settlement landed on. */
  function detailOf(outcome: RunControlOutcome, composite: boolean): string {
    const settlement = readComposerSettlement(outcome, composite);
    return settlement.kind === "refused" ? settlement.notice.detail : "";
  }

  it("names the guard's act where the daemon's reason names one of the four", () => {
    // "Change what it asks for and confirm again" names nothing a person can change
    // in this box when the blocker is an older send sitting in the queue.
    const detail = detailOf(rejectedRewind("composite.no_pending_send"), true);

    expect(detail).toContain("Cancel the queued items");
    expect(detail).toContain("What you typed is still here.");
  });

  it("keeps the wire code as the refusal's code on that path too", () => {
    const settlement = readComposerSettlement(rejectedRewind("composite.no_pending_send"), true);

    expect(settlement.kind === "refused" ? settlement.notice.code : undefined).toBe(
      "composite.no_pending_send",
    );
  });

  it("keeps the general sentence for a rejection naming no guard", () => {
    // The honest one when the console does not know what would make the request
    // admissible — and the negative control for the branch above.
    const detail = detailOf(rejectedRewind("run.invalid_transition"), true);

    expect(detail).toContain("change what it asks for");
    expect(detail).not.toContain("Cancel the queued items");
  });

  it("keeps it for a reason carrying a FRAGMENT of a guard's name and not the name", () => {
    // The narrowed reading's control on this path. A reason that merely mentions a
    // pending send is not the guard "no pending send", and answering it with the
    // composite's remedy would tell a person to drain a queue on the strength of a
    // word — which is the reading `rollback-result.ts` narrowed away from and which
    // the typed `rejectionGuard` member will settle outright.
    const detail = detailOf(rejectedRewind("An earlier queued send is still pending."), true);

    expect(detail).toContain("change what it asks for");
    expect(detail).not.toContain("Cancel the queued items");
  });

  it("offers the guard reading only where the request WAS a composite", () => {
    // The gate `InterventionBody.tsx` puts on the history half, held here too. The
    // four guards are the edit-and-resend's own, and their remedies name acts —
    // pause the run, drain the queue — that a dispatch carrying no correction never
    // asked anyone to perform. A BARE rewind refused for a live turn is the reachable
    // form of that: same reason on the wire, different dispatch behind it.
    const bare = detailOf(rejectedRewind("composite.no_active_turn"), false);
    const withCorrection = detailOf(rejectedRewind("composite.no_active_turn"), true);

    expect(bare).toContain("change what it asks for");
    expect(bare).not.toContain("Pause or stop the run first");
    expect(withCorrection).toContain("Pause or stop the run first");
  });

  it("offers it for no rejected steer, which can carry no replacement at all", () => {
    // The second reachable form, and the one that reaches a participant sooner: a
    // steer refused because a turn is running is an ordinary answer, and it used to
    // be told to "correct the message again" about a message it never corrected.
    const detail = detailOf(settledAt("rejected", "no_active_turn"), false);

    expect(detail).toContain("change what it asks for");
    expect(detail).not.toContain("Pause or stop the run first");
  });

  it("renders the daemon's own reason as the code on every one of those arms", () => {
    // Gating the SENTENCE never gates the code: the machine-readable half is the
    // daemon's on all three dispatches, and dropping it would leave a refusal a
    // person cannot look up.
    const codes = [
      readComposerSettlement(rejectedRewind("composite.no_active_turn"), false),
      readComposerSettlement(rejectedRewind("composite.no_active_turn"), true),
      readComposerSettlement(settledAt("rejected", "no_active_turn"), false),
    ].map((settlement) => (settlement.kind === "refused" ? settlement.notice.code : undefined));

    expect(codes).toStrictEqual([
      "composite.no_active_turn",
      "composite.no_active_turn",
      "no_active_turn",
    ]);
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
