// The execution-root model, driven directly.

import { describe, expect, it } from "vitest";

import { WORKTREE_STATE_PRESENTATION } from "./execution-root-model.js";

describe("worktree-model — the state vocabularies are the contract's", () => {
  it("says where a failed row comes from", () => {
    // There is no `worktree.failed` event, so `failed` arrives on a re-read.
    expect(WORKTREE_STATE_PRESENTATION.failed.meaning).toContain("status re-read");
  });

  it("spends amber and red on exactly the states that earn them", () => {
    expect(WORKTREE_STATE_PRESENTATION.dirty.tone).toBe("attention");
    expect(WORKTREE_STATE_PRESENTATION.failed.tone).toBe("failure");
    // Negative control: a merely uninteresting state stays neutral.
    expect(WORKTREE_STATE_PRESENTATION.ready.tone).toBe("neutral");
    expect(WORKTREE_STATE_PRESENTATION.merged.tone).toBe("neutral");
  });
});
