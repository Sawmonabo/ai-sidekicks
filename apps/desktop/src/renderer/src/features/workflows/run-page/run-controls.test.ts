// The control vocabulary's two claims: the bound is measured in bytes, and a refusal never
// carries the value it refused. Each case has a negative control that fails against the lazy
// version (`String.length` agrees with byte count on ASCII).

import { WORKFLOW_CANCEL_REASON_BYTE_CAP } from "@ai-sidekicks/contracts";

import { describe, expect, it } from "vitest";

import { measureUtf8ByteLength } from "@renderer/lib/utf8-byte-length.js";
import {
  WORKFLOW_RUN_CONTROL_ACTIONS,
  WORKFLOW_RUN_CONTROL_ORIGIN,
  actAlreadyInFlightRefusal,
  cancelReasonBudget,
  reasonPastBoundRefusal,
} from "./run-controls.js";

describe("the reason bound is measured on the encoding", () => {
  // Read through the budget rather than a measurement function of this module's own: the bound
  // must reach the renderer's one `measureUtf8ByteLength`, since a second measurement would
  // agree on ASCII and drift on surrogate pairs or normalization.
  it("counts UTF-8 bytes and not code units", () => {
    expect(cancelReasonBudget("abc").byteLength).toBe(3);
    expect(cancelReasonBudget("é").byteLength).toBe(2);
    expect(cancelReasonBudget("😀").byteLength).toBe(4);
  });

  it("agrees byte for byte with the measurement the durable path's own cap uses", () => {
    // One ruler, asserted as one: two functions that agree today disagree the day either
    // grows a rule, and a cap makes that invisible.
    for (const text of ["abc", "é", "😀", "a".repeat(1000), ""]) {
      expect(cancelReasonBudget(text).byteLength).toBe(measureUtf8ByteLength(text));
    }
  });

  it("negative control: the code-unit count disagrees, so the case above is not vacuous", () => {
    // `"😀".length` is 2 and `"é".length` is 1, so an implementation returning `value.length`
    // would pass the ASCII case and fail here.
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
    // A negative remainder would reach `formatByteQuantity`, which answers "—" for one, so an
    // operator past the bound would be told nothing about how far past they are.
    expect(
      cancelReasonBudget("a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP + 64)).remainingBytes,
    ).toBe(0);
  });

  it("negative control: an empty reason has the whole budget", () => {
    expect(cancelReasonBudget("").remainingBytes).toBe(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    expect(cancelReasonBudget("").isPastBound).toBe(false);
  });
});

describe("the refusals the run controls raise themselves", () => {
  it("names the bound and never the refused value", () => {
    const reason = "a-user-sentence-that-must-not-be-echoed";
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
    // "Denied" would be an adjudication nobody performed: this press put no question to a
    // daemon.
    expect(refusal.detail.toLowerCase()).not.toContain("denied");
  });

  it("says which act is already outstanding, and names no method string", () => {
    const cancel = actAlreadyInFlightRefusal("cancel");
    const resume = actAlreadyInFlightRefusal("resume");
    expect(cancel.detail).not.toBe(resume.detail);
    // The wire method name belongs to the daemon contract; printing it would copy it.
    for (const refusal of [cancel, resume]) {
      expect(refusal.detail).not.toContain("workflow.");
    }
  });

  it("negative control: the refusal says the press was not queued, so it is not a wait", () => {
    // Without this, a refusal reading "hold on, this is coming" would pass, and a queue would
    // perform an act nobody re-confirmed against a run the first call has moved.
    expect(actAlreadyInFlightRefusal("cancel").detail).toContain("not queued");
  });

  it("negative control: both actions are covered, so neither case above is one arm", () => {
    expect(WORKFLOW_RUN_CONTROL_ACTIONS).toStrictEqual(["cancel", "resume"]);
    expect(
      WORKFLOW_RUN_CONTROL_ACTIONS.map((action) => actAlreadyInFlightRefusal(action).detail),
    ).toHaveLength(2);
  });
});
