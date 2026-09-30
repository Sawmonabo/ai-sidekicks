// The cancel reason's bound is measured in UTF-8 bytes, the unit the daemon enforces, and not in
// code units: `String.length` agrees with the byte count on ASCII and drifts on everything else.

import { WORKFLOW_CANCEL_REASON_BYTE_CAP } from "@ai-sidekicks/contracts";

import { describe, expect, it } from "vitest";

import { cancelReasonBudget } from "./run-controls.js";

describe("the reason bound is measured on the encoding", () => {
  // Read through the budget rather than a measurement function of this module's own: the bound
  // must reach the renderer's one `measureUtf8ByteLength`, since a second measurement would
  // agree on ASCII and drift on surrogate pairs or normalization.
  it("counts UTF-8 bytes and not code units", () => {
    expect(cancelReasonBudget("abc").byteLength).toBe(3);
    expect(cancelReasonBudget("é").byteLength).toBe(2);
    expect(cancelReasonBudget("😀").byteLength).toBe(4);
  });

  it("admits a reason exactly at the bound and refuses one byte past it", () => {
    const atBound = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    expect(cancelReasonBudget(atBound).isPastBound).toBe(false);
    expect(cancelReasonBudget(atBound).remainingBytes).toBe(0);
    expect(cancelReasonBudget(`${atBound}a`).isPastBound).toBe(true);
  });
});
