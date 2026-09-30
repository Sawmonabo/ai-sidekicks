// The section's own refusals: the code each constructor mints, and the set they close.

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_LIST_REFUSAL_CODES,
  manifestReadInFlightRefusal,
  payloadFetchInFlightRefusal,
  readFailureRefusal,
} from "./artifact-list-refusals.js";

describe("artifact list refusals — a read that threw", () => {
  it("names this reader as the origin and never quotes the rejected value", () => {
    // The sentence names the leg and stops there: a rejection off the wire can carry user
    // content.
    const refusal = readFailureRefusal(new Error("/Users/someone/secret-branch"));
    expect(refusal.code).toBe("read-threw");
    expect(refusal.origin).toBe("artifact-list-reader");
    expect(refusal.detail).not.toContain("secret-branch");
  });

  it("keeps a daemon envelope's dotted code, its own words, and its retry hint", () => {
    // A 403 and a rate limit must not both collapse to `read-threw` with the daemon's words
    // discarded.
    const refusal = readFailureRefusal({
      message: "This artifact is not available.",
      data: { type: "artifact.not_found", fields: { retryAfter: 30 } },
    });
    expect(refusal.code).toBe("artifact.not_found");
    expect(refusal.detail).toBe("This artifact is not available.");
    expect(refusal.retry?.afterSeconds).toBe(30);
  });

  it("keeps the origin a refusal thrown across the bridge already named", () => {
    // Structural rather than `instanceof`: the value crossed a realm, so its prototype chain
    // is gone and `instanceof` would replace the author's origin with this section's.
    const refusal = readFailureRefusal({
      refusal: { origin: "daemon", code: "artifact.not_found", detail: "No such artifact." },
    });
    expect(refusal.origin).toBe("daemon");
    expect(refusal.code).toBe("artifact.not_found");
  });

  it("negative control: a value whose `message` getter throws does not escape", () => {
    // This runs inside an error handler; a throw from here would be a second failure raised
    // while reporting the first, outside every `catch`.
    const hostile = {
      get message(): string {
        throw new Error("read me and see");
      },
    };
    const refusal = readFailureRefusal(hostile);
    expect(refusal.origin).toBe("artifact-list-reader");
    expect(refusal.detail.length).toBeGreaterThan(0);
  });
});

describe("artifact list refusals — the closed vocabulary", () => {
  it("is exactly the codes the module's own constructors mint, each named once", () => {
    // Every constructor is driven, so a code minted but not enumerated, or enumerated but
    // never minted, fails here.
    const minted = [
      readFailureRefusal(new Error("boom")).code,
      payloadFetchInFlightRefusal("artifact-1").code,
      manifestReadInFlightRefusal("artifact-1").code,
    ];

    expect([...ARTIFACT_LIST_REFUSAL_CODES].toSorted()).toStrictEqual(minted.toSorted());
    expect(new Set(ARTIFACT_LIST_REFUSAL_CODES).size).toBe(ARTIFACT_LIST_REFUSAL_CODES.length);
  });

  it("negative control: a code another author owns is not a member of this section's set", () => {
    // The daemon's own codes reach this section and render unchanged; the set must not claim
    // them.
    expect([...ARTIFACT_LIST_REFUSAL_CODES]).not.toContain("artifact.not_found");
  });
});
