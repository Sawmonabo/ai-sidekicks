// What a retirement's confirmation states, and the id it sends.

import { describe, expect, it } from "vitest";

import { DISPOSAL_CONSEQUENCE, disposalSubjectFor } from "./disposal-subject.js";

const WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000020";

describe("disposalSubjectFor", () => {
  it("states the retirement as recorded now and cleaned afterwards", () => {
    // `WorktreeRetireResponse.state` is `retired` and carries no cleanup instant: retire
    // records the transition and the sweep removes the disk afterwards, so files still on
    // disk are an ordinary state and the sentence must not read as a failure.
    expect(DISPOSAL_CONSEQUENCE).toContain("cleanup sweep afterwards");
    expect(DISPOSAL_CONSEQUENCE).toContain("ordinary state");
  });

  it("negative control: the consequence does not claim the bytes are already gone", () => {
    expect(DISPOSAL_CONSEQUENCE).not.toMatch(/are gone/);
  });

  it("carries the id the act will send", () => {
    const subject = disposalSubjectFor(WORKTREE_ID);
    expect(subject.rootId).toBe(WORKTREE_ID);
    expect(subject.consequence).toBe(DISPOSAL_CONSEQUENCE);
  });
});
