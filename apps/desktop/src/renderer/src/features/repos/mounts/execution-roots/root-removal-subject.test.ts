// What a removal's confirmation states, and the id it sends.

import { describe, expect, it } from "vitest";

import { ROOT_REMOVAL_CONSEQUENCE, rootRemovalSubjectFor } from "./root-removal-subject";

const WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000020";

describe("rootRemovalSubjectFor", () => {
  it("states the removal as recorded now and cleaned afterwards", () => {
    // `WorktreeRetireResponse.state` is `retired` and carries no cleanup instant: retire
    // records the transition and the sweep removes the disk afterwards, so files still on
    // disk are an ordinary state and the sentence must not read as a failure.
    expect(ROOT_REMOVAL_CONSEQUENCE).toContain("cleanup sweep afterwards");
    expect(ROOT_REMOVAL_CONSEQUENCE).toContain("ordinary state");
  });

  it("negative control: the consequence does not claim the bytes are already gone", () => {
    expect(ROOT_REMOVAL_CONSEQUENCE).not.toMatch(/are gone/);
  });

  it("carries the id the act will send", () => {
    const subject = rootRemovalSubjectFor(WORKTREE_ID);
    expect(subject.rootId).toBe(WORKTREE_ID);
    expect(subject.consequence).toBe(ROOT_REMOVAL_CONSEQUENCE);
  });
});
