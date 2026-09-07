// The four readings of the shared-terminal lease, off the one roster reply.
//
// A pure fold over the seam's observation union, so every arm is one call. The two
// that matter most are the two the wire cannot tell apart and the reader must: a read
// that has not answered, and a session whose lease is free. Collapsing them renders a
// claim about the session nothing checked, and that mistake is invisible on screen —
// which is why it is pinned here rather than in a render.

import { describe, expect, it } from "vitest";

import type { ParticipantId, RuntimeNodeRosterResponse } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../core/index.js";
import type { NodeRosterObservation } from "../../../seats/index.js";
import { controlHolderReadingOf } from "./control-holder-reading.js";

const HOLDER = "019b7892-1c00-79a4-8110-cca0117a0550" as ParticipantId;

const REFUSAL: ConsoleRefusal = {
  code: "roster-unscripted",
  detail: "The scenario scripts no roster reply.",
  origin: "fixture",
};

/** A roster reply carrying one holder reading and no rows, which is a real reply. */
function replyHolding(controlHolder: ParticipantId | null): RuntimeNodeRosterResponse {
  return { nodes: [], controlHolder };
}

function observationOf(response: RuntimeNodeRosterResponse): NodeRosterObservation {
  return { kind: "read", response };
}

describe("control holder reading", () => {
  it("reads an unasked roster as unread rather than as a free lease", () => {
    expect(controlHolderReadingOf({ kind: "unread" })).toEqual({ kind: "unread" });
  });

  it("carries the seam's own refusal through rather than swallowing it", () => {
    // The refusal object travels by identity, not by copy: the line renders it with
    // the console's own refusal shape, and a re-wrapped one would show a code this
    // console minted for a refusal the daemon made.
    const reading = controlHolderReadingOf({ kind: "unreadable", refusal: REFUSAL });
    expect(reading).toEqual({ kind: "unreadable", refusal: REFUSAL });
    expect(reading.kind === "unreadable" && reading.refusal).toBe(REFUSAL);
  });

  it("reads a null holder as unheld, and decomposes it no further", () => {
    // `null` carries two facts the control plane serves identically — a free lease,
    // and a held one suppressed behind a producer it cannot vouch live. A second arm
    // here would be this renderer inventing a distinction the wire withholds.
    expect(controlHolderReadingOf(observationOf(replyHolding(null)))).toEqual({ kind: "unheld" });
  });

  it("reads a holder as held, carrying the identity verbatim", () => {
    expect(controlHolderReadingOf(observationOf(replyHolding(HOLDER)))).toEqual({
      kind: "held",
      participantId: HOLDER,
    });
  });

  it("negative control: unread and unheld are different readings of different facts", () => {
    // Without this the two absence arms could be folded into one and every assertion
    // above would still pass — the failure this whole module exists to prevent.
    expect(controlHolderReadingOf({ kind: "unread" })).not.toEqual(
      controlHolderReadingOf(observationOf(replyHolding(null))),
    );
  });

  it("holds the two constant arms stable, so a render does not churn on identity", () => {
    expect(controlHolderReadingOf({ kind: "unread" })).toBe(
      controlHolderReadingOf({ kind: "unread" }),
    );
    expect(controlHolderReadingOf(observationOf(replyHolding(null)))).toBe(
      controlHolderReadingOf(observationOf(replyHolding(null))),
    );
  });
});
