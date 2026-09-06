// The control vocabulary's two claims: the bound is measured in BYTES, and a
// refusal never carries the value it refused.
//
// Both are the kind of rule that passes by accident under a lazy implementation —
// `String.length` agrees with the byte count for the whole of ASCII, and a refusal
// that interpolated the reason would read perfectly well in a test that only
// checked for the word "bytes". So every case below has a negative control that
// fails against the lazy version.

import { describe, expect, it } from "vitest";

import { measureUtf8ByteLength } from "../../../persistence/index.js";
import { WORKFLOW_CANCEL_REASON_BYTE_CAP } from "../../../core/index.js";
import {
  WORKFLOW_RUN_CONTROL_ACTIONS,
  WORKFLOW_RUN_CONTROL_ORIGIN,
  actAlreadyInFlightRefusal,
  cancelReasonBudget,
  reasonPastBoundRefusal,
} from "./run-controls.js";

describe("the reason bound is measured on the encoding", () => {
  // Read through the budget rather than through a measurement function of this
  // module's own: there is no such function any more. This surface had its own
  // `utf8ByteLength`, commented as the console's first — `persistence/` had been
  // measuring the durable path's cap with `measureUtf8ByteLength` since before it —
  // and the two agreed on ASCII while each was free to grow a surrogate-pair or
  // normalisation rule the other did not. The budget is what a caller consumes, so
  // asserting on it checks the bound AND the fact that it is reached through the one
  // measurement `apps/desktop/AGENTS.md` §Chokepoints gives every cap.
  it("counts UTF-8 bytes and not code units", () => {
    expect(cancelReasonBudget("abc").byteLength).toBe(3);
    expect(cancelReasonBudget("é").byteLength).toBe(2);
    expect(cancelReasonBudget("😀").byteLength).toBe(4);
  });

  it("agrees byte for byte with the measurement the durable path's own cap uses", () => {
    // One ruler, asserted as one. Two functions that agree today are two functions
    // that disagree on the day either grows a rule — and a cap is exactly where that
    // is invisible until somebody's sentence is refused at a length nothing states.
    for (const text of ["abc", "é", "😀", "a".repeat(1000), ""]) {
      expect(cancelReasonBudget(text).byteLength).toBe(measureUtf8ByteLength(text));
    }
  });

  it("negative control: the code-unit count disagrees, so the case above is not vacuous", () => {
    // `"😀".length` is 2 and `"é".length` is 1. An implementation that returned
    // `value.length` would pass the ASCII case and fail here — which is exactly the
    // implementation this bound has to rule out, since a cap counted in code units
    // refuses a shorter sentence in one script than in another.
    expect("😀".length).not.toBe(cancelReasonBudget("😀").byteLength);
    expect("é".length).not.toBe(cancelReasonBudget("é").byteLength);
  });

  it("admits a reason exactly at the bound and refuses one byte past it", () => {
    const atBound = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    expect(cancelReasonBudget(atBound).isPastBound).toBe(false);
    expect(cancelReasonBudget(atBound).remainingBytes).toBe(0);
    expect(cancelReasonBudget(`${atBound}a`).isPastBound).toBe(true);
  });

  it("floors the remaining budget at zero rather than reporting a negative", () => {
    // A negative remainder would reach `formatByteQuantity`, which answers "—" for
    // one — so the operator past the bound would be told nothing at all about how
    // far past they are.
    expect(
      cancelReasonBudget("a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP + 64)).remainingBytes,
    ).toBe(0);
  });

  it("negative control: an empty reason has the whole budget", () => {
    expect(cancelReasonBudget("").remainingBytes).toBe(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    expect(cancelReasonBudget("").isPastBound).toBe(false);
  });
});

describe("the refusals this surface raises itself", () => {
  it("names the bound and never the refused value", () => {
    const reason = "a-participant-sentence-that-must-not-be-echoed";
    const refusal = reasonPastBoundRefusal(cancelReasonBudget(reason.repeat(400)));
    expect(refusal.origin).toBe(WORKFLOW_RUN_CONTROL_ORIGIN);
    expect(refusal.code).toBe("reason-past-bound");
    expect(refusal.detail).toContain(String(WORKFLOW_CANCEL_REASON_BYTE_CAP));
    expect(refusal.detail).not.toContain(reason);
  });

  it("reports a duplicate press as in flight rather than as a denial", () => {
    const refusal = actAlreadyInFlightRefusal("cancel");
    expect(refusal.origin).toBe(WORKFLOW_RUN_CONTROL_ORIGIN);
    expect(refusal.code).toBe("act-already-in-flight");
    // "Denied" would be an adjudication nobody performed: this press put no question
    // to a daemon at all, because the previous one is still outstanding.
    expect(refusal.detail.toLowerCase()).not.toContain("denied");
  });

  it("says which act is already outstanding, and names no method string", () => {
    const cancel = actAlreadyInFlightRefusal("cancel");
    const resume = actAlreadyInFlightRefusal("resume");
    expect(cancel.detail).not.toBe(resume.detail);
    // The wire this control travels is the growth port's, and the port composes its
    // own refusal naming it. A method string printed here would be this module
    // restating a wire fact whose one home is the slate row.
    for (const refusal of [cancel, resume]) {
      expect(refusal.detail).not.toContain("workflow.");
    }
  });

  it("negative control: the refusal says the press was not queued, so it is not a wait", () => {
    // Without this, the cases above would be satisfied by a refusal that read as
    // "hold on, this is coming" — which is what a queue would do, and a queue is the
    // one disposition this control must never take: it would perform an act nobody
    // re-confirmed against a run whose state the first call has already moved.
    expect(actAlreadyInFlightRefusal("cancel").detail).toContain("not queued");
  });

  it("negative control: both actions are covered, so neither case above is one arm", () => {
    expect(WORKFLOW_RUN_CONTROL_ACTIONS).toStrictEqual(["cancel", "resume"]);
    expect(
      WORKFLOW_RUN_CONTROL_ACTIONS.map((action) => actAlreadyInFlightRefusal(action).detail),
    ).toHaveLength(2);
  });
});
