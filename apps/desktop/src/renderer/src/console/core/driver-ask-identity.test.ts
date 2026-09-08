// The identity rule, asserted where it is composed rather than at either reader.
//
// Both readers file the ask in a map of their own, so a case that only drove one of
// them would prove the rule for that map and say nothing about the other. What is
// asserted here is the rule itself: two members, in one order, both present or no
// identity at all.

import { describe, expect, it } from "vitest";

import { driverAskIdentitySegments } from "./driver-ask-identity.js";
import { structuralKey } from "./structural-key.js";

describe("driverAskIdentitySegments — a run and a provider-local ask id", () => {
  it("separates two runs raising the provider's same ask id", () => {
    expect(structuralKey(driverAskIdentitySegments("run-a", "ask-1") ?? [])).not.toBe(
      structuralKey(driverAskIdentitySegments("run-b", "ask-1") ?? []),
    );
  });

  it("gives one run's one ask the same segments every time it is asked", () => {
    expect(driverAskIdentitySegments("run-a", "ask-1")).toStrictEqual(["run-a", "ask-1"]);
  });

  it("orders the run before the provider's id, so no pair re-reads as another", () => {
    expect(structuralKey(driverAskIdentitySegments("run-a", "ask-1") ?? [])).not.toBe(
      structuralKey(driverAskIdentitySegments("ask-1", "run-a") ?? []),
    );
  });

  it("refuses to identify an ask that names no run", () => {
    expect(driverAskIdentitySegments(undefined, "ask-1")).toBeUndefined();
  });

  it("refuses to identify an ask whose run is the empty string", () => {
    expect(driverAskIdentitySegments("", "ask-1")).toBeUndefined();
  });

  it("refuses to identify a run-scoped row that names no ask", () => {
    expect(driverAskIdentitySegments("run-a", undefined)).toBeUndefined();
    expect(driverAskIdentitySegments("run-a", "")).toBeUndefined();
  });

  // Without this the four refusals above would pass over a function that answered
  // `undefined` for everything, and every caller's fail-closed arm would be the only
  // arm this module had.
  it("negative control: a fully named ask is identified rather than refused", () => {
    expect(driverAskIdentitySegments("run-a", "ask-1")).not.toBeUndefined();
  });
});
