// The setup card's status.
import { describe, expect, it } from "vitest";

import { WORKTREE_SETUP_OUTPUT_MAX_LEN, WorktreeSetupStatusSchema } from "../worktree-setup.js";

const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";

describe("repo.worktreeSetupSubscribe: the setup card", () => {
  const status = (output: string) => ({
    worktreeId: WORKTREE_ID,
    state: "failed",
    steps: [
      { stage: "make_tree", label: "Make the tree", state: "succeeded", elapsedMs: 820 },
      {
        stage: "project_steps",
        label: "pnpm install",
        state: "failed",
        elapsedMs: 4100,
        error: "exit code 1",
        output,
      },
      { stage: "warm_caches", label: "Warm caches", state: "pending" },
    ],
  });

  it("carries each step with its output, capped", () => {
    expect(WorktreeSetupStatusSchema.safeParse(status("ERR_PNPM_FETCH_404")).success).toBe(true);
    expect(
      WorktreeSetupStatusSchema.safeParse(status("x".repeat(WORKTREE_SETUP_OUTPUT_MAX_LEN + 1)))
        .success,
    ).toBe(false);
  });
});
