// What a read that threw becomes: its origin, its code, and never the rejected value.

import { describe, expect, it } from "vitest";

import { readFailureRefusal } from "./artifact-list-refusals.js";

describe("artifact list refusals — a read that threw", () => {
  it("names this reader as the origin and never quotes the rejected value", () => {
    // The sentence names the leg and stops there: a rejection off the wire can carry user
    // content.
    const refusal = readFailureRefusal(new Error("/Users/someone/secret-branch"));
    expect(refusal.code).toBe("read-threw");
    expect(refusal.origin).toBe("artifact-list-reader");
    expect(refusal.detail).not.toContain("secret-branch");
  });
});
