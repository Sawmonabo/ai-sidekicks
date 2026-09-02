// The control vocabulary's two claims: the bound is measured in BYTES, and a
// refusal never carries the value it refused.
//
// Both are the kind of rule that passes by accident under a lazy implementation —
// `String.length` agrees with the byte count for the whole of ASCII, and a refusal
// that interpolated the reason would read perfectly well in a test that only
// checked for the word "bytes". So every case below has a negative control that
// fails against the lazy version.

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
  WORKFLOW_RUN_CONTROL_ACTIONS,
  WORKFLOW_RUN_CONTROL_ORIGIN,
  cancelReasonBudget,
  reasonPastBoundRefusal,
  unregisteredRunControl,
  utf8ByteLength,
} from "./run-controls.js";

describe("the reason bound is measured on the encoding", () => {
  it("counts UTF-8 bytes and not code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("negative control: the code-unit count disagrees, so the case above is not vacuous", () => {
    // `"😀".length` is 2 and `"é".length` is 1. An implementation that returned
    // `value.length` would pass the ASCII case and fail here — which is exactly the
    // implementation this bound has to rule out, since a cap counted in code units
    // refuses a shorter sentence in one script than in another.
    expect("😀".length).not.toBe(utf8ByteLength("😀"));
    expect("é".length).not.toBe(utf8ByteLength("é"));
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

  it("reports an unreachable control as not-checked rather than as a denial", () => {
    const refusal = unregisteredRunControl("cancel");
    expect(refusal.code).toBe("wire-unregistered");
    // "Denied" would be an adjudication nobody performed. The distinction is the
    // whole of rule 8's `not-checked`: no question was put to a daemon at all.
    expect(refusal.detail.toLowerCase()).not.toContain("denied");
  });

  it("says which act is unreachable, and names no method string", () => {
    const cancel = unregisteredRunControl("cancel");
    const resume = unregisteredRunControl("resume");
    expect(cancel.detail).not.toBe(resume.detail);
    // No `workflow.*` method is registered anywhere in the corpus, so printing one
    // would be this surface inventing the wire whose absence it is reporting.
    for (const refusal of [cancel, resume]) {
      expect(refusal.detail).not.toContain("workflow.");
    }
  });

  it("negative control: both actions are covered, so neither case above is one arm", () => {
    expect(WORKFLOW_RUN_CONTROL_ACTIONS).toStrictEqual(["cancel", "resume"]);
    expect(
      WORKFLOW_RUN_CONTROL_ACTIONS.map((action) => unregisteredRunControl(action).detail),
    ).toHaveLength(2);
  });
});
