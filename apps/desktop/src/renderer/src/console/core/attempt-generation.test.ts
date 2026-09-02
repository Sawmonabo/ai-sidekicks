// The predicate five holders now share, asked directly.
//
// Each of them already proves its own supersession behaviour against its own wire,
// and those tests are what says the extraction changed nothing. What they cannot
// ask is the mechanism on its own — in particular that a teardown leaves the object
// USABLE, which every holder needs because a React effect's cleanup runs between
// the two invocations strict mode makes of one effect, and which none of them can
// isolate from the read or write it happens to be tearing down.

import { describe, expect, it } from "vitest";

import { AttemptGeneration } from "./attempt-generation.js";

describe("attempt generation", () => {
  it("says the attempt it just handed out is the current one", () => {
    const attempts = new AttemptGeneration();
    expect(attempts.isCurrent(attempts.begin())).toBe(true);
  });

  it("negative control: a later attempt supersedes the one before it", () => {
    // Without this, the case above would pass over a generation that never moved —
    // which is the whole defect, since every attempt would then look current and
    // every superseded reply would install.
    const attempts = new AttemptGeneration();
    const first = attempts.begin();
    const second = attempts.begin();
    expect(attempts.isCurrent(first)).toBe(false);
    expect(attempts.isCurrent(second)).toBe(true);
  });

  it("hands the same round to two callers that only captured it", () => {
    // The second shape: several writes belong to one round because what supersedes
    // them is the teardown rather than each other.
    const attempts = new AttemptGeneration();
    const read = attempts.current();
    const alongside = attempts.current();
    expect(attempts.isCurrent(read)).toBe(true);
    expect(attempts.isCurrent(alongside)).toBe(true);
  });

  it("supersedes a captured round without starting one", () => {
    const attempts = new AttemptGeneration();
    const read = attempts.current();
    attempts.supersedeAll();
    expect(attempts.isCurrent(read)).toBe(false);
  });

  it("is usable after a teardown, so a re-opened holder is not dead", () => {
    // The property strict mode needs: `supersedeAll` is an invalidation and never
    // a terminal state, so the round claimed after one is current like any other.
    const attempts = new AttemptGeneration();
    attempts.supersedeAll();
    const reopened = attempts.begin();
    expect(attempts.isCurrent(reopened)).toBe(true);
  });

  it("keeps two generations independent, so one holder never invalidates another", () => {
    const mine = new AttemptGeneration();
    const theirs = new AttemptGeneration();
    const attempt = mine.begin();
    theirs.begin();
    theirs.supersedeAll();
    expect(mine.isCurrent(attempt)).toBe(true);
  });
});
