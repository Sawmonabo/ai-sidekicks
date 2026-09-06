// What the port's three refusal builders put on a refusal, and what they never drop.
//
// Two of them answer for a wire nobody asked and one for a call that REJECTED, and the
// difference between those is the whole subject here: the rejecting one is handed a
// value nothing validated, reads it through the console's one total normalizer, and
// carries what that recovered onto `cause`. An earlier revision read the daemon's own
// dotted code there and threw it away, so a surface settling through this builder
// showed `call-rejected` for a failure whose code the other side had sent — and its
// sibling one navigation later showed that code. The cases below pin the carry, and
// their negative control drives the shape that dropped it.
//
// `growthUnavailableFromRejection` HAS NO PRODUCTION CALLER TODAY — every growth call
// in the console settles through `readings/read-settlement.ts` instead — so this suite
// is what keeps the builder honest, and the module's own header says why the builder
// is kept at all.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, refuse } from "../../core/index.js";
import {
  growthScriptedReplyUnavailable,
  growthUnavailable,
  growthUnavailableFromRejection,
} from "./growth-port.js";

/** The dotted code a JSON-RPC envelope carries at `data.type`. */
const DAEMON_REFUSAL_CODE = "session.list_unavailable";

/** The sentence the same envelope carries, which a person reads verbatim. */
const DAEMON_REFUSAL_MESSAGE = "The node is not accepting session reads right now.";

/** The envelope shape a daemon refusal crosses the preload boundary as. */
function daemonEnvelope(): unknown {
  return { code: -32603, message: DAEMON_REFUSAL_MESSAGE, data: { type: DAEMON_REFUSAL_CODE } };
}

describe("the growth port's refusal builders", () => {
  it("names the wire and its owner when nothing is registered to ask", () => {
    const refusal = growthUnavailable("sessionList");

    expect(refusal.status).toBe("unavailable");
    expect(refusal.code).toBe("wire-unregistered");
    expect(refusal.operationId).toBe("sessionList");
    expect(refusal.slateRow).toBe("session-directory-read");
    // The owning document travels as a structured member and never inside the
    // sentence a person reads.
    expect(refusal.owningDocument.length).toBeGreaterThan(0);
    expect(refusal.detail).not.toContain(refusal.owningDocument);
  });

  it("carries the seam's own diagnosis when a scripted reply never came", () => {
    const refusal = growthScriptedReplyUnavailable(
      "sessionList",
      "reply-abandoned",
      "the engine was torn down before the clock reached the answer",
    );

    expect(refusal.code).toBe("reply-abandoned");
    expect(refusal.detail).toContain("torn down");
  });

  it("keeps the daemon's dotted code on `cause` when a call rejects with an envelope", () => {
    const refusal = growthUnavailableFromRejection("sessionList", daemonEnvelope());

    // `code` says which seam broke — one fact, however the rejection spelled itself.
    expect(refusal.code).toBe("call-rejected");
    expect(refusal.origin).toBe("growth-port");
    // `cause` says what the other side sent, which is the half a person acts on.
    expect(refusal.cause.code).toBe(DAEMON_REFUSAL_CODE);
    expect(refusal.cause.detail).toBe(DAEMON_REFUSAL_MESSAGE);
    // And the sentence names the wire that did not answer, then quotes it.
    expect(refusal.detail).toContain("did not answer");
    expect(refusal.detail).toContain(DAEMON_REFUSAL_MESSAGE);
  });

  it("negative control: the code alone cannot tell two daemon failures apart", () => {
    // The shape this replaces, driven. Two rejections carrying DIFFERENT registered
    // codes settle to the same `code`, so a consumer reading only that member sees one
    // failure where the daemon reported two — which is why `cause` exists and why it
    // is required on this arm rather than optional.
    const listRefusal = growthUnavailableFromRejection("sessionList", daemonEnvelope());
    const readRefusal = growthUnavailableFromRejection("sessionRead", {
      code: -32603,
      message: "That session is not on this node.",
      data: { type: "session.not_found" },
    });

    expect(readRefusal.code).toBe(listRefusal.code);
    expect(readRefusal.cause.code).not.toBe(listRefusal.cause.code);
  });

  it("unwraps a refusal that travelled as an error rather than restamping it", () => {
    // The arm a scripted daemon refusal takes: it is thrown verbatim, carried inside
    // an error, and what a person reads is still the author's own code.
    const carried = new ConsoleRefusalError(
      refuse("daemon", DAEMON_REFUSAL_CODE, DAEMON_REFUSAL_MESSAGE),
    );

    const refusal = growthUnavailableFromRejection("sessionList", carried);

    expect(refusal.cause.code).toBe(DAEMON_REFUSAL_CODE);
    expect(refusal.cause.origin).toBe("daemon");
  });

  it("stays total for a rejection carrying nothing machine-readable", () => {
    const refusal = growthUnavailableFromRejection("sessionList", new Error("socket closed"));

    // A synthesized code built from the origin, and the message a producer wrote —
    // so a failure nobody can classify is still distinguishable from a read nobody put.
    expect(refusal.cause.code).toBe("growth-port-call-failed");
    expect(refusal.cause.detail).toBe("socket closed");
    expect(refusal.detail).toContain("socket closed");
  });
});
